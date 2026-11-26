// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  decideNavigation,
  isSafeExternalUrl,
  isTrustedWebOrigin,
  openExternalSafely,
  shouldTrustCertificateError,
} from "./window-security";

const serverUrl = "https://bayclaw.example.com/bayclaw";

describe("isSafeExternalUrl", () => {
  it("allows http and https", () => {
    expect(isSafeExternalUrl("https://bayclaw.example.com/docs")).toBe(true);
    expect(isSafeExternalUrl("http://localhost:13000")).toBe(true);
  });

  it("blocks schemes the OS could open or execute", () => {
    for (const url of [
      "file:///etc/passwd",
      "smb://192.0.2.10/Share",
      "javascript:alert(1)",
      "data:text/html,hi",
      "vbscript:msgbox(1)",
      "bayclaw-open://open?path=%2FVolumes%2FShare",
      "ftp://bayclaw.example.com",
      "mailto:someone@example.com",
      "about:blank",
    ]) {
      expect(isSafeExternalUrl(url)).toBe(false);
    }
  });

  it("rejects empty and malformed values", () => {
    expect(isSafeExternalUrl("")).toBe(false);
    expect(isSafeExternalUrl("   ")).toBe(false);
    expect(isSafeExternalUrl("not a url")).toBe(false);
    expect(isSafeExternalUrl(undefined as unknown as string)).toBe(false);
  });
});

describe("openExternalSafely", () => {
  it("calls the opener for an allowed URL", async () => {
    const opener = vi.fn(async () => undefined);
    await expect(
      openExternalSafely("https://bayclaw.example.com/docs", opener),
    ).resolves.toBe(true);
    expect(opener).toHaveBeenCalledWith("https://bayclaw.example.com/docs");
  });

  it("never calls the opener for a blocked URL", async () => {
    const opener = vi.fn(async () => undefined);
    for (const url of ["file:///etc/passwd", "smb://192.0.2.10/Share", "javascript:alert(1)"]) {
      await expect(openExternalSafely(url, opener)).resolves.toBe(false);
    }
    expect(opener).not.toHaveBeenCalled();
  });

  it("reports a rejected OS handoff as false", async () => {
    const opener = vi.fn(async () => {
      throw new Error("no handler");
    });
    await expect(openExternalSafely("https://bayclaw.example.com", opener)).resolves.toBe(
      false,
    );
  });
});

describe("shouldTrustCertificateError", () => {
  const config = { serverUrl, allowSelfSignedCert: true };

  it("trusts a failing URL on the configured host when opted in", () => {
    expect(
      shouldTrustCertificateError("https://bayclaw.example.com/api/config", config),
    ).toBe(true);
  });

  it("never trusts another host", () => {
    expect(shouldTrustCertificateError("https://evil.example.com/", config)).toBe(false);
  });

  it("never trusts a different port", () => {
    expect(
      shouldTrustCertificateError("https://bayclaw.example.com:8443/api", config),
    ).toBe(false);
  });

  it("never trusts anything when the opt-in is off", () => {
    expect(
      shouldTrustCertificateError("https://bayclaw.example.com/api/config", {
        serverUrl,
        allowSelfSignedCert: false,
      }),
    ).toBe(false);
  });

  it("rejects unparsable URLs", () => {
    expect(shouldTrustCertificateError("not a url", config)).toBe(false);
  });
});

describe("isTrustedWebOrigin", () => {
  it("accepts the configured origin regardless of path", () => {
    expect(isTrustedWebOrigin("https://bayclaw.example.com/issues/1", serverUrl)).toBe(
      true,
    );
  });

  it("rejects foreign origins, null senders, and garbage", () => {
    expect(isTrustedWebOrigin("https://evil.example.com/", serverUrl)).toBe(false);
    expect(isTrustedWebOrigin(undefined, serverUrl)).toBe(false);
    expect(isTrustedWebOrigin(null, serverUrl)).toBe(false);
    expect(isTrustedWebOrigin("not a url", serverUrl)).toBe(false);
  });
});

describe("decideNavigation", () => {
  it("allows same-origin navigation", () => {
    expect(decideNavigation("https://bayclaw.example.com/issues/1", serverUrl)).toBe(
      "allow",
    );
  });

  it("sends other web URLs to the OS browser", () => {
    expect(decideNavigation("https://docs.example.com/guide", serverUrl)).toBe(
      "external",
    );
    expect(decideNavigation("http://localhost:13000", serverUrl)).toBe("external");
  });

  it("blocks non-web schemes", () => {
    for (const url of [
      "file:///etc/passwd",
      "smb://192.0.2.10/Share",
      "javascript:alert(1)",
      "data:text/html,hi",
      "bayclaw-open://open?path=%2FVolumes%2FShare",
    ]) {
      expect(decideNavigation(url, serverUrl)).toBe("block");
    }
  });

  it("blocks empty and malformed targets", () => {
    expect(decideNavigation("", serverUrl)).toBe("block");
    expect(decideNavigation("not a url", serverUrl)).toBe("block");
  });
});
