// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  COLLAB_PATH_MAX_BYTES,
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
