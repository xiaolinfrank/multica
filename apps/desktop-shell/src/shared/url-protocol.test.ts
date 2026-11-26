// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  PROTOCOL_SCHEME,
  extractProtocolUrlFromArgv,
  isSameServerOrigin,
  isValidServerUrl,
  normalizeServerUrl,
  parseBayclawOpenUrl,
  serverOrigin,
} from "./url-protocol";

describe("normalizeServerUrl", () => {
  it("keeps an https origin and strips the trailing slash", () => {
    expect(normalizeServerUrl("https://bayclaw.example.com")).toBe(
      "https://bayclaw.example.com",
    );
    expect(normalizeServerUrl("https://bayclaw.example.com/")).toBe(
      "https://bayclaw.example.com",
    );
  });

  it("keeps a subpath deployment without its trailing slash", () => {
    expect(normalizeServerUrl("https://bayclaw.example.com/bayclaw/")).toBe(
      "https://bayclaw.example.com/bayclaw",
    );
  });

  it("drops query strings and fragments", () => {
    expect(normalizeServerUrl("https://bayclaw.example.com/?x=1#frag")).toBe(
      "https://bayclaw.example.com",
    );
  });

  it("accepts http only for loopback hosts", () => {
    expect(normalizeServerUrl("http://localhost:13000")).toBe(
      "http://localhost:13000",
    );
    expect(normalizeServerUrl("http://127.0.0.1:13000/")).toBe(
      "http://127.0.0.1:13000",
    );
    expect(normalizeServerUrl("http://[::1]:13000")).toBe("http://[::1]:13000");
  });

  it("rejects http for non-loopback hosts", () => {
    expect(normalizeServerUrl("http://bayclaw.example.com")).toBeNull();
    expect(normalizeServerUrl("http://192.0.2.10:8080")).toBeNull();
  });

  it("rejects credentials", () => {
    expect(normalizeServerUrl("https://user:pass@bayclaw.example.com")).toBeNull();
    expect(normalizeServerUrl("https://user@bayclaw.example.com")).toBeNull();
  });

  it("rejects non-http(s) schemes and empty hosts", () => {
    expect(normalizeServerUrl("ftp://bayclaw.example.com")).toBeNull();
    expect(normalizeServerUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeServerUrl("https://")).toBeNull();
    expect(normalizeServerUrl("")).toBeNull();
    expect(normalizeServerUrl("   ")).toBeNull();
    expect(normalizeServerUrl("not a url")).toBeNull();
  });

  it("exposes a boolean helper with identical semantics", () => {
    expect(isValidServerUrl("https://bayclaw.example.com")).toBe(true);
    expect(isValidServerUrl("http://bayclaw.example.com")).toBe(false);
  });
});

describe("serverOrigin", () => {
  it("returns the origin without the base path", () => {
    expect(serverOrigin("https://bayclaw.example.com/bayclaw")).toBe(
      "https://bayclaw.example.com",
    );
  });

  it("returns an empty string for garbage", () => {
    expect(serverOrigin("not a url")).toBe("");
  });
});

describe("isSameServerOrigin", () => {
  const serverUrl = "https://bayclaw.example.com/bayclaw";

  it("matches the same origin regardless of path", () => {
    expect(isSameServerOrigin("https://bayclaw.example.com/any/path", serverUrl)).toBe(
      true,
    );
  });

  it("rejects a different host, port, or scheme", () => {
    expect(isSameServerOrigin("https://evil.example.com/", serverUrl)).toBe(false);
    expect(isSameServerOrigin("https://bayclaw.example.com:8443/", serverUrl)).toBe(
      false,
    );
    expect(isSameServerOrigin("http://bayclaw.example.com/", serverUrl)).toBe(false);
  });

  it("rejects null, undefined, and garbage", () => {
    expect(isSameServerOrigin(null, serverUrl)).toBe(false);
    expect(isSameServerOrigin(undefined, serverUrl)).toBe(false);
    expect(isSameServerOrigin("not a url", serverUrl)).toBe(false);
    expect(isSameServerOrigin(serverUrl, "")).toBe(false);
  });
});

describe("parseBayclawOpenUrl", () => {
  it("decodes a path from the documented deep link", () => {
    const result = parseBayclawOpenUrl(
      `${PROTOCOL_SCHEME}://open?path=${encodeURIComponent("/Volumes/Team Space/Sub")}`,
    );
    expect(result).toEqual({ path: "/Volumes/Team Space/Sub" });
  });

  it("accepts an uppercase scheme", () => {
    const result = parseBayclawOpenUrl(
      "BAYCLAW-OPEN://open?path=%2FVolumes%2FShare",
    );
    expect(result).toEqual({ path: "/Volumes/Share" });
  });

  it("ignores a smuggled host parameter and any extra parameters", () => {
    const result = parseBayclawOpenUrl(
      `${PROTOCOL_SCHEME}://open?host=${encodeURIComponent("\\\\evil.example.com\\Share")}` +
        `&path=${encodeURIComponent("/Volumes/Share/Sub")}&trusted=1`,
    );
    expect(result).toEqual({ path: "/Volumes/Share/Sub" });
  });

  it("rejects other actions, other schemes, and missing hosts", () => {
    expect(
      parseBayclawOpenUrl(`${PROTOCOL_SCHEME}://edit?path=%2FVolumes%2FShare`),
    ).toBeNull();
    expect(parseBayclawOpenUrl("https://open?path=%2FVolumes%2FShare")).toBeNull();
    expect(parseBayclawOpenUrl(`${PROTOCOL_SCHEME}://?path=%2FVolumes%2FShare`)).toBeNull();
    expect(
      parseBayclawOpenUrl(`${PROTOCOL_SCHEME}://open/extra?path=%2FVolumes%2FShare`),
    ).toBeNull();
  });

  it("rejects a missing, empty, or whitespace-only path", () => {
    expect(parseBayclawOpenUrl(`${PROTOCOL_SCHEME}://open`)).toBeNull();
    expect(parseBayclawOpenUrl(`${PROTOCOL_SCHEME}://open?path=`)).toBeNull();
    expect(parseBayclawOpenUrl(`${PROTOCOL_SCHEME}://open?path=%20%20`)).toBeNull();
  });

  it("rejects control characters in the path", () => {
    expect(
      parseBayclawOpenUrl(`${PROTOCOL_SCHEME}://open?path=%2FVolumes%2FShare%00`),
    ).toBeNull();
    expect(
      parseBayclawOpenUrl(`${PROTOCOL_SCHEME}://open?path=%2FVolumes%2FShare%0A`),
    ).toBeNull();
  });

  it("accepts exactly 1024 UTF-8 bytes and rejects one more", () => {
    const atLimit = `/${"a".repeat(1023)}`;
    const overLimit = `/${"a".repeat(1024)}`;
    expect(Buffer.byteLength(atLimit, "utf8")).toBe(1024);
    expect(
      parseBayclawOpenUrl(
        `${PROTOCOL_SCHEME}://open?path=${encodeURIComponent(atLimit)}`,
      ),
    ).toEqual({ path: atLimit });
    expect(
      parseBayclawOpenUrl(
        `${PROTOCOL_SCHEME}://open?path=${encodeURIComponent(overLimit)}`,
      ),
    ).toBeNull();
  });

  it("trims surrounding whitespace inside the value", () => {
    expect(
      parseBayclawOpenUrl(
        `${PROTOCOL_SCHEME}://open?path=${encodeURIComponent("  /Volumes/Share  ")}`,
      ),
    ).toEqual({ path: "/Volumes/Share" });
  });
});

describe("extractProtocolUrlFromArgv", () => {
  it("finds a deep link among Electron arguments", () => {
    const url = "bayclaw-open://open?path=%2FVolumes%2FShare";
    expect(
      extractProtocolUrlFromArgv(["/Applications/BayClaw", "--flag", url]),
    ).toBe(url);
  });

  it("matches the scheme case-insensitively and strips surrounding quotes", () => {
    expect(
      extractProtocolUrlFromArgv(['"BAYCLAW-OPEN://open?path=x"']),
    ).toBe("BAYCLAW-OPEN://open?path=x");
  });

  it("returns null when no deep link is present", () => {
    expect(extractProtocolUrlFromArgv([])).toBeNull();
    expect(extractProtocolUrlFromArgv(["--url=https://bayclaw.example.com"])).toBeNull();
    expect(extractProtocolUrlFromArgv(["bayclaw-open:/open?path=x"])).toBeNull();
  });
});
