// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  COLLAB_PATH_MAX_BYTES,
  collabPathAddresses,
  isAbsoluteCollabPath,
  normalizeCollabPath,
} from "./collab-path";

// Canonical layer for the collab_path parse matrix: the UI surfaces assert
// wiring (which control writes which field), not these rules.
describe("normalizeCollabPath", () => {
  it("trims surrounding whitespace off a real NAS path", () => {
    const path =
      "/Volumes/人机协作空间/AI医药联合创新平台/01高质量数据集/01.01回顾性队列数据集（JIA）";
    expect(normalizeCollabPath(`  ${path}  `)).toEqual({ ok: true, value: path });
  });

  // Blank is not an error — it is how the user clears the field, and callers
  // turn the null into an explicit null on the wire.
  it.each(["", "   ", "\t\n "])("resolves blank input %j to null", (raw) => {
    expect(normalizeCollabPath(raw)).toEqual({ ok: true, value: null });
  });

  it.each([
    ["/Volumes/share/project", "POSIX"],
    ["\\\\nas\\share\\project", "UNC"],
    ["Z:/share/project", "Windows drive, forward slashes"],
    ["z:\\share\\project", "Windows drive, backslashes"],
  ])("accepts %s (%s)", (path) => {
    expect(normalizeCollabPath(path)).toEqual({ ok: true, value: path });
  });

  // A relative path is the mistake worth catching in the field: the daemon
  // would resolve it inside the task's private workdir, which is the one
  // place a deliverable must not land.
  it.each([
    "01高质量数据集",
    "./deliverables",
    "../shared",
    "~/Desktop/share",
    "nas/share",
    "Z:relative",
    "\\single-backslash",
  ])("rejects the non-absolute path %j", (path) => {
    expect(normalizeCollabPath(path)).toEqual({
      ok: false,
      reason: "not_absolute",
    });
  });

  it("rejects control characters but tolerates a tab", () => {
    expect(normalizeCollabPath("/Volumes/sha\u0007re")).toEqual({
      ok: false,
      reason: "control_characters",
    });
    expect(normalizeCollabPath("/Volumes/sha\tre")).toEqual({
      ok: true,
      value: "/Volumes/sha\tre",
    });
  });

  // The server bounds bytes, not characters. A CJK path of 400 characters is
  // 1200 bytes, so a character-based check here would pass a value the server
  // then rejects with a raw 400.
  it("measures the length limit in UTF-8 bytes", () => {
    const asciiAtLimit = "/" + "a".repeat(COLLAB_PATH_MAX_BYTES - 1);
    expect(normalizeCollabPath(asciiAtLimit)).toEqual({
      ok: true,
      value: asciiAtLimit,
    });
    expect(normalizeCollabPath(asciiAtLimit + "a")).toEqual({
      ok: false,
      reason: "too_long",
    });

    // 341 × 3 bytes + 1 = 1024 bytes exactly; one more character overflows.
    const cjkAtLimit = "/" + "空".repeat(341);
    expect(normalizeCollabPath(cjkAtLimit)).toEqual({
      ok: true,
      value: cjkAtLimit,
    });
    expect(normalizeCollabPath(cjkAtLimit + "空")).toEqual({
      ok: false,
      reason: "too_long",
    });
  });
});

describe("isAbsoluteCollabPath", () => {
  it("does not treat a bare drive letter as absolute", () => {
    expect(isAbsoluteCollabPath("Z:")).toBe(false);
    expect(isAbsoluteCollabPath("Z:/")).toBe(true);
  });

  it("requires a letter before the drive colon", () => {
    expect(isAbsoluteCollabPath("1:/share")).toBe(false);
  });
});

describe("collabPathAddresses", () => {
  const HOST = "10.0.0.50";

  it("addresses a macOS mount through the configured file server", () => {
    expect(collabPathAddresses("/Volumes/人机协作空间/项目/模块", HOST)).toEqual({
      smbUrl: `smb://${HOST}/${encodeURIComponent("人机协作空间")}/${encodeURIComponent("项目")}/${encodeURIComponent("模块")}`,
      uncPath: "\\\\10.0.0.50\\人机协作空间\\项目\\模块",
    });
  });

  // macOS writes its own mount URLs percent-encoded, so Finder decodes them
  // back; a raw space would truncate the address instead.
  it("percent-encodes a segment containing a space", () => {
    const { smbUrl } = collabPathAddresses("/Volumes/AI 平台/报告", HOST);
    expect(smbUrl).toBe(
      `smb://${HOST}/AI%20${encodeURIComponent("平台")}/${encodeURIComponent("报告")}`,
    );
  });

  it("keeps a UNC path on the server it names, when that is the configured one", () => {
    expect(collabPathAddresses("\\\\nas01\\共享\\项目", "NAS01")).toEqual({
      smbUrl: `smb://nas01/${encodeURIComponent("共享")}/${encodeURIComponent("项目")}`,
      uncPath: "\\\\nas01\\共享\\项目",
    });
  });

  // SECURITY. These paths come out of content an agent or a user wrote, and an
  // smb:// click asks the reader's OS to authenticate against whatever host the
  // string names. Honouring a UNC path's own host would turn any comment into a
  // one-click mount of an attacker's server, behind a credential prompt the
  // reader has every reason to read as their own NAS.
  it("refuses a UNC path naming a host the deployment did not configure", () => {
    expect(
      collabPathAddresses("\\\\evil.example.com\\pwn\\x", HOST),
    ).toEqual({ smbUrl: null, uncPath: null });
  });

  it("refuses a UNC path when no file server is configured at all", () => {
    expect(collabPathAddresses("\\\\nas01\\共享\\项目", "")).toEqual({
      smbUrl: null,
      uncPath: null,
    });
  });

  // Guessing would produce an address that fails in a way the reader cannot
  // diagnose, which is worse than the clipboard.
  it.each([
    ["/mnt/share/项目", HOST, "a Linux mount point names no share"],
    ["/media/nas/项目", HOST, "same for removable media"],
    ["Z:\\共享\\项目", HOST, "a drive letter hides a per-machine mapping"],
    ["/Volumes/人机协作空间/项目", "", "no file server is configured"],
    ["/Volumes/", HOST, "the mount root is not a share"],
    ["/Volumes//项目", HOST, "an empty share segment"],
    ["\\\\nas01", HOST, "a bare server is not a directory"],
    ["", HOST, "an empty path"],
  ])("gives no address for %s (%s)", (path, host) => {
    expect(collabPathAddresses(path, host)).toEqual({
      smbUrl: null,
      uncPath: null,
    });
  });
});
