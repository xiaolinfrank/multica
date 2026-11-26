// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildServerConfigUrl,
  fetchCollabSpaceHost,
  shouldScopeInsecureTls,
} from "./server-config";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => handler(request, response));
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("buildServerConfigUrl", () => {
  it("appends the config path exactly once", () => {
    expect(buildServerConfigUrl("https://bayclaw.example.com")).toBe(
      "https://bayclaw.example.com/api/config",
    );
    expect(buildServerConfigUrl("https://bayclaw.example.com/")).toBe(
      "https://bayclaw.example.com/api/config",
    );
    expect(buildServerConfigUrl("https://bayclaw.example.com/bayclaw/")).toBe(
      "https://bayclaw.example.com/bayclaw/api/config",
    );
  });

  it("rejects garbage", () => {
    expect(buildServerConfigUrl("not a url")).toBeNull();
    expect(buildServerConfigUrl("")).toBeNull();
  });
});

describe("shouldScopeInsecureTls", () => {
  const target = "https://bayclaw.example.com/api/config";

  it("allows a disabled-verification agent only on the exact configured host", () => {
    expect(shouldScopeInsecureTls(target, "bayclaw.example.com", true)).toBe(true);
  });

  it("is false when the opt-in is off", () => {
    expect(shouldScopeInsecureTls(target, "bayclaw.example.com", false)).toBe(false);
  });

  it("is false for a different host or port", () => {
    expect(shouldScopeInsecureTls(target, "other.example.com", true)).toBe(false);
    expect(
      shouldScopeInsecureTls("https://bayclaw.example.com:8443/api/config", "bayclaw.example.com", true),
    ).toBe(false);
  });

  it("is false for garbage URLs", () => {
    expect(shouldScopeInsecureTls("not a url", "bayclaw.example.com", true)).toBe(false);
  });
});

describe("fetchCollabSpaceHost", () => {
  it("reads and trims collab_space_host over real HTTP", async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ collab_space_host: "  nas.example.internal  " }));
    });

    await expect(
      fetchCollabSpaceHost(baseUrl, { allowSelfSignedCert: false, timeoutMs: 2000 }),
    ).resolves.toBe("nas.example.internal");
  });

  it("returns an empty string for a missing or non-string value", async () => {
    const baseUrl = await startServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url === "/api/config") {
        response.end(JSON.stringify({ collab_space_host: 42 }));
      } else {
        response.end(JSON.stringify({}));
      }
    });

    await expect(
      fetchCollabSpaceHost(baseUrl, { allowSelfSignedCert: false, timeoutMs: 2000 }),
    ).resolves.toBe("");
  });

  it("returns an empty string for an invalid host value", async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ collab_space_host: "nas/example" }));
    });

    await expect(
      fetchCollabSpaceHost(baseUrl, { allowSelfSignedCert: false, timeoutMs: 2000 }),
    ).resolves.toBe("");
  });

  it("returns an empty string for a non-2xx status or invalid JSON", async () => {
    const baseUrl = await startServer((request, response) => {
      if (request.url === "/api/config") {
        response.writeHead(500);
        response.end("boom");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{not json");
    });

    await expect(
      fetchCollabSpaceHost(baseUrl, { allowSelfSignedCert: false, timeoutMs: 2000 }),
    ).resolves.toBe("");
  });

  it("returns an empty string when the server is unreachable", async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200);
      response.end("{}");
    });
    // Close the server before dialing it so the connection is refused.
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );

    await expect(
      fetchCollabSpaceHost(baseUrl, { allowSelfSignedCert: false, timeoutMs: 300 }),
    ).resolves.toBe("");
  });

  it("honours an injected transport", async () => {
    const urls: string[] = [];
    const host = await fetchCollabSpaceHost("https://bayclaw.example.com/bayclaw", {
      allowSelfSignedCert: false,
      fetchImpl: async (url) => {
        urls.push(url);
        return { status: 200, body: JSON.stringify({ collab_space_host: "nas.example.internal" }) };
      },
    });

    expect(host).toBe("nas.example.internal");
    expect(urls).toEqual(["https://bayclaw.example.com/bayclaw/api/config"]);
  });

  it("rejects a non-string or unparsable server URL", async () => {
    await expect(
      fetchCollabSpaceHost("not a url", { allowSelfSignedCert: false }),
    ).resolves.toBe("");
  });
});
