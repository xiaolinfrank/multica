// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  shell: {
    openPath: vi.fn().mockResolvedValue(""),
    showItemInFolder: vi.fn(),
  },
}));

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shell } from "electron";
import { openLocalPathSafely } from "./local-path";

// Real directories rather than a mocked `stat`: the whole point of this module
// is what it does with what is actually on disk, and a mock would assert the
// branch we wrote instead of the branch the filesystem produces.
const root = await mkdtemp(join(tmpdir(), "multica-local-path-"));
const directory = join(root, "项目");
const file = join(root, "report.pdf");
const bundle = join(root, "Calculator.app");

await mkdir(directory);
await writeFile(file, "x");
await mkdir(bundle);

afterAll(() => rm(root, { recursive: true, force: true }));

beforeEach(() => {
  vi.mocked(shell.openPath).mockClear().mockResolvedValue("");
  vi.mocked(shell.showItemInFolder).mockClear();
});

describe("openLocalPathSafely", () => {
  it("opens a plain directory in the file manager", async () => {
    await expect(openLocalPathSafely(directory)).resolves.toEqual({
      ok: true,
      action: "opened",
    });
    expect(shell.openPath).toHaveBeenCalledWith(directory);
  });

  it("trims the value before using it", async () => {
    await expect(openLocalPathSafely(`  ${directory}  `)).resolves.toEqual({
      ok: true,
      action: "opened",
    });
    expect(shell.openPath).toHaveBeenCalledWith(directory);
  });

  // A file has a default handler, and handing it to the OS would run that
  // handler. Revealing it is just as useful to the reader and inert.
  it("reveals a file rather than opening it", async () => {
    await expect(openLocalPathSafely(file)).resolves.toEqual({
      ok: true,
      action: "revealed",
    });
    expect(shell.showItemInFolder).toHaveBeenCalledWith(file);
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  // THE security case. A macOS application bundle IS a directory, so the
  // is-it-a-directory test alone would hand `/Applications/Anything.app` to
  // LaunchServices and start it — from a path an agent wrote into a comment.
  it("reveals an application bundle instead of launching it", async () => {
    await expect(openLocalPathSafely(bundle)).resolves.toEqual({
      ok: true,
      action: "revealed",
    });
    expect(shell.showItemInFolder).toHaveBeenCalledWith(bundle);
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("sees through a trailing separator on a bundle name", async () => {
    await expect(openLocalPathSafely(`${bundle}/`)).resolves.toEqual({
      ok: true,
      action: "revealed",
    });
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("reports a missing path without touching the shell", async () => {
    await expect(openLocalPathSafely(join(root, "nope"))).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("passes on a failure from the shell", async () => {
    vi.mocked(shell.openPath).mockResolvedValue("no handler");

    await expect(openLocalPathSafely(directory)).resolves.toEqual({
      ok: false,
      reason: "error",
      error: "no handler",
    });
  });

  it.each([
    ["relative/path", "a relative path"],
    ["./report", "an explicitly relative path"],
    ["~/Documents", "a home-relative path"],
    ["", "an empty string"],
    ["   ", "whitespace"],
    ["/Volumes/share/\u0000etc", "an embedded NUL"],
    ["/Volumes/share/a\nb", "an embedded newline"],
    [`/Volumes/${"x".repeat(1100)}`, "a value past the length ceiling"],
    [42, "a non-string"],
    [null, "null"],
    [undefined, "undefined"],
  ])("refuses %s (%s)", async (value) => {
    await expect(openLocalPathSafely(value)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });
});
