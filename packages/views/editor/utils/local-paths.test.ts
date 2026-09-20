// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  localPathFromHref,
  localPathHref,
  preprocessLocalPaths,
} from "@multica/ui/markdown";

/**
 * Pure detector for the mount-rooted path autolink. Lives in
 * @multica/ui/markdown (no test runner there), exercised here where views'
 * vitest can reach it — the same arrangement as issue-identifiers.test.ts.
 *
 * This is the canonical layer for the detection matrix: the component and
 * renderer tests assert wiring, not which strings count as a path.
 */

const NAS = "/Volumes/人机协作空间/AI医药联合创新平台/01高质量数据集";

function link(path: string): string {
  return `[${path}](${localPathHref(path)})`;
}

describe("preprocessLocalPaths", () => {
  it("rewrites a macOS volume path, Chinese segments and all", () => {
    expect(preprocessLocalPaths(`报告写到 ${NAS} 了`)).toBe(
      `报告写到 ${link(NAS)} 了`,
    );
  });

  it.each([
    ["/mnt/share/data", "a Linux mount point"],
    ["/media/nas/reports", "removable/network media"],
    ["\\\\nas01\\协作空间\\项目", "a UNC share"],
    ["Z:\\协作空间\\项目", "a mapped drive, backslash form"],
    ["Z:/协作空间/项目", "a mapped drive, forward-slash form"],
  ])("rewrites %s (%s)", (path) => {
    expect(preprocessLocalPaths(`see ${path} ok`)).toBe(`see ${link(path)} ok`);
  });

  // A colon with no space after it is how a Chinese sentence introduces a
  // path; an allow-list of ASCII openers would silently miss every one.
  it.each([
    ["路径：", "："],
    ["路径:", ":"],
    ["（", "（"],
    ["(", "("],
    ["**", "**"],
  ])("starts a path directly after %s", (prefix) => {
    const out = preprocessLocalPaths(`${prefix}${NAS}`);
    expect(out).toBe(`${prefix}${link(NAS)}`);
  });

  it("rewrites several paths in one line", () => {
    const a = "/Volumes/share/a";
    const b = "/mnt/share/b";
    expect(preprocessLocalPaths(`${a} 和 ${b}`)).toBe(`${link(a)} 和 ${link(b)}`);
  });

  // The path is one token in a larger string, not a location of its own.
  it.each([
    "https://example.com/Volumes/share/x",
    "http://nas/mnt/data",
    "smb://nas/Volumes/share",
    "~/Volumes/share",
    "./media/logo.png",
  ])("leaves %s alone", (text) => {
    expect(preprocessLocalPaths(`see ${text} ok`)).toBe(`see ${text} ok`);
  });

  // Machine-local paths belong to whichever machine wrote the sentence, so an
  // "open" affordance beside one would point at something the reader lacks.
  it.each(["/etc/hosts", "/usr/local/bin", "/home/agent/workdir", "/tmp/out.csv"])(
    "leaves the machine-local path %s alone",
    (text) => {
      expect(preprocessLocalPaths(`wrote ${text}`)).toBe(`wrote ${text}`);
    },
  );

  it("leaves a bare mount root alone", () => {
    expect(preprocessLocalPaths("mounted under /Volumes/ today")).toBe(
      "mounted under /Volumes/ today",
    );
  });

  it.each([
    ["writes to /Volumes/share/项目。", "/Volumes/share/项目", "。"],
    ["see /Volumes/share/out.", "/Volumes/share/out", "."],
    ["(/Volumes/share/out)", "/Volumes/share/out", ")"],
    ["路径：/Volumes/share/x，然后", "/Volumes/share/x", "，然后"],
  ])("stops %s at the sentence, not the path", (input, path, tail) => {
    expect(preprocessLocalPaths(input)).toBe(
      input.replace(path + tail, link(path) + tail),
    );
  });

  // Directories on the share really are named this way, so a full-width closer
  // is part of the path far more often than it ends a parenthetical. The
  // balance check is what tells the two apart.
  it("keeps a balanced full-width parenthesis inside a directory name", () => {
    const path = "/Volumes/share/01.01回顾性队列数据集（JIA）";
    expect(preprocessLocalPaths(`见 ${path}。`)).toBe(`见 ${link(path)}。`);
  });

  it.each([
    ["（", "）"],
    ["(", ")"],
  ])("drops a %s closer the path never opened", (open, close) => {
    const path = "/Volumes/share/x";
    expect(preprocessLocalPaths(`${open}${path}${close}`)).toBe(
      `${open}${link(path)}${close}`,
    );
  });

  // Chinese prose puts no space after a comma, so the sentence would otherwise
  // run straight into the path.
  it.each(["，然后写报告", "。下一步", "、以及别的", "；再说", "！注意", "？对吗"])(
    "ends the path at %s",
    (tail) => {
      const path = "/Volumes/share/x";
      expect(preprocessLocalPaths(`路径：${path}${tail}`)).toBe(
        `路径：${link(path)}${tail}`,
      );
    },
  );

  // A trailing slash is how a writer says "this is a directory"; trimming it
  // would quietly rewrite what they meant.
  it("keeps a trailing slash", () => {
    expect(preprocessLocalPaths("put it in /Volumes/share/项目/")).toBe(
      "put it in " + link("/Volumes/share/项目/"),
    );
  });

  // A path with a space in it cannot be told apart from the sentence around
  // it; linking the part before the space is the documented behaviour.
  it("stops at whitespace inside a directory name", () => {
    expect(preprocessLocalPaths("see /Volumes/my share/x")).toBe(
      `see ${link("/Volumes/my")} share/x`,
    );
  });

  it.each([
    ["`/Volumes/share/x`", "inline code"],
    ["```\n/Volumes/share/x\n```", "a fenced block"],
    ["$/Volumes/share/x$", "inline math"],
  ])("leaves %s untouched (%s)", (input) => {
    expect(preprocessLocalPaths(input)).toBe(input);
  });

  it("does not nest inside an existing markdown link", () => {
    const input = "[report](/Volumes/share/report.pdf)";
    expect(preprocessLocalPaths(input)).toBe(input);
  });

  it("returns the input unchanged when there is no mount root", () => {
    const input = "no paths here, just prose about /Volumes";
    expect(preprocessLocalPaths(input)).toBe(input);
  });
});

describe("localPathHref / localPathFromHref", () => {
  it("round-trips a path with characters a URL would otherwise eat", () => {
    const path = "/Volumes/共享 空间/a#b?c%d";
    expect(localPathFromHref(localPathHref(path))).toBe(path);
  });

  it.each([
    ["https://example.com", "an ordinary URL"],
    ["mention://issue/MUL-1", "another internal scheme"],
    ["localpath://", "an empty payload"],
    ["localpath://%E0%A4%A", "a malformed escape"],
    [undefined, "no href at all"],
  ])("returns null for %s (%s)", (href) => {
    expect(localPathFromHref(href)).toBeNull();
  });
});
