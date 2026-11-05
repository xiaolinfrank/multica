// @vitest-environment node
import { describe, expect, it } from "vitest";
import { unstable_doesMiddlewareMatch, unstable_getResponseFromNextConfig, getRewrittenUrl } from "next/experimental/testing/server";
import { config } from "../proxy";
import { INPUT_AWARE_API_REWRITE } from "./input-upload-routing";

const id = "10000000-0000-4000-8000-000000000001";
const path = `/api/cockpit/inputs/${id}/versions/${id}/transfers/${id}/bytes`;

describe("dedicated input stream routing", () => {
  it("excludes only stream byte destinations from the cloning proxy", () => {
    // Cockpit transfers byte streams and the upload-file handler both stream
    // request bodies, so neither may enter Proxy's body clone.
    for (const suffix of ["", "/", "?trace=1"]) expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: `https://web.test${path}${suffix}` })).toBe(false);
    for (const excluded of ["/api/upload-file", "/api/upload-file/"]) expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: `https://web.test${excluded}` })).toBe(false);
    for (const candidate of [path.replace(/bytes$/, "finalize"), `${path}/unexpected`, "/api/cockpit/inputs", "/api/upload-files"]) {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: `https://web.test${candidate}` })).toBe(true);
    }
  });
  it("lets byte paths reach the dynamic route while ordinary APIs keep their backend rewrite", async () => {
    const nextConfig = { rewrites: async () => [{ source: INPUT_AWARE_API_REWRITE, destination: "https://backend.test/api/:path" }] };
    const bytes = await unstable_getResponseFromNextConfig({ url: `https://web.test${path}`, nextConfig });
    expect(getRewrittenUrl(bytes)).toBeNull();
    const ordinary = await unstable_getResponseFromNextConfig({ url: "https://web.test/api/cockpit/inputs", nextConfig });
    expect(getRewrittenUrl(ordinary)).toBe("https://backend.test/api/cockpit/inputs");
  });
});
