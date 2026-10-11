// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamInputUpload } from "./input-upload-stream";

const params = {
  inputId: "10000000-0000-4000-8000-000000000001",
  versionId: "20000000-0000-4000-8000-000000000002",
  transferId: "30000000-0000-4000-8000-000000000003",
};
function request(extra: Record<string, string> = {}, body: BodyInit = "original file bytes") {
  return new Request("http://web.test/api/cockpit/inputs/upload", {
    method: "PUT", body, duplex: "half",
    headers: { "content-type": "application/octet-stream", "x-input-transfer-revision": "3", ...extra },
  } as RequestInit);
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("input upload stream", () => {
  it("forwards a bounded stream with the original credential and CSRF context, without JSON or attachment conversion", async () => {
    vi.stubEnv("REMOTE_API_URL", "http://backend.test/prefix");
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.body).toBeInstanceOf(ReadableStream);
      expect(await new Response(init.body).text()).toBe("original file bytes");
      const headers = new Headers(init.headers);
      expect(headers.get("x-workspace-id")).toBe(params.inputId);
      expect(headers.get("x-input-transfer-revision")).toBe("3");
      expect(headers.get("x-csrf-token")).toBe("session-proof");
      expect(headers.get("authorization")).toBe("Bearer test-token");
      expect(headers.get("x-forwarded-host")).toBeNull();
      expect(init.redirect).toBe("manual");
      return Response.json({ current: { state: "awaiting_finalize" } }, { headers: { "set-cookie": "renewed=1; HttpOnly" } });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await streamInputUpload(request({ "x-workspace-id": params.inputId, "x-csrf-token": "session-proof", authorization: "Bearer test-token", "x-forwarded-host": "untrusted.test" }), params);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`http://backend.test/prefix/api/cockpit/inputs/${params.inputId}/versions/${params.versionId}/transfers/${params.transferId}/bytes`);
    expect(await result.json()).toEqual({ current: { state: "awaiting_finalize" } });
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.getSetCookie()).toEqual(["renewed=1; HttpOnly"]);
  });

  it("rejects an oversized declaration and malformed session identity before contacting the backend", async () => {
    vi.stubEnv("REMOTE_API_URL", "http://backend.test");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect((await streamInputUpload(request({ "content-length": `${500 * 1024 * 1024 + 1}` }), params)).status).toBe(413);
    expect((await streamInputUpload(request(), { ...params, transferId: "../other" })).status).toBe(400);
    expect((await streamInputUpload(request({ "x-input-transfer-revision": "9223372036854775808" }), params)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("caps chunked byte streams without buffering or trusting a Content-Length header", async () => {
    vi.stubEnv("REMOTE_API_URL", "http://backend.test");
    const chunk = new Uint8Array(1024 * 1024);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(stream) { pulls++; stream.enqueue(chunk); } });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      for (;;) { const item = await reader.read(); if (item.done) break; }
      return Response.json({});
    }));
    const result = await streamInputUpload(request({}, body), params);
    expect(result.status).toBe(413);
    expect(pulls).toBeLessThan(505);
  });

  it("reports an unknown result after lost response and never retries the uploaded session", async () => {
    vi.stubEnv("REMOTE_API_URL", "http://backend.test");
    const fetcher = vi.fn(async () => { throw new Error("connection lost after commit"); });
    vi.stubGlobal("fetch", fetcher);
    const result = await streamInputUpload(request(), params);
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ code: "input_upload_result_unknown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves exact backend rejection and refuses credential-bearing redirects", async () => {
    vi.stubEnv("REMOTE_API_URL", "http://backend.test");
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ code: "transfer_lease_changed" }, { status: 409 }))
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "https://other.test/upload" } }));
    vi.stubGlobal("fetch", fetcher);
    const rejected = await streamInputUpload(request(), params);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ code: "transfer_lease_changed" });
    const redirected = await streamInputUpload(request(), params);
    expect(redirected.status).toBe(502);
    expect(redirected.headers.get("location")).toBeNull();
  });
});
