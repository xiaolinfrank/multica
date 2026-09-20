import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { shell } from "electron";

/**
 * Reveal a local filesystem path in the OS file manager.
 *
 * The renderer reaches this through the `shell:open-local-path` IPC channel,
 * and the paths it sends come from content agents wrote — an issue comment, a
 * project property. That provenance decides the whole design of this module:
 * the input is untrusted, so the one thing it must never become is a way to
 * run something.
 *
 * `shell.openPath` asks the OS to open the target with its default handler. On
 * a directory that means a Finder / Explorer window, which is what this feature
 * is for. On anything else it means launching a program with the file — and on
 * macOS "anything else" includes directories, because an application bundle IS
 * a directory. `shell.openPath("/Applications/Calculator.app")` starts
 * Calculator.
 *
 * So the rule is: open only a real directory that is not a bundle, and reveal
 * everything else. `shell.showItemInFolder` selects the item in a file-manager
 * window and never consults LaunchServices, so a path naming an executable, a
 * document or an app bundle is still useful to the reader and still inert.
 */

/** Bounds the value before it touches the filesystem. Matches the server's
 *  collab_path ceiling; a longer string is not a path anyone typed. */
const MAX_PATH_BYTES = 1024;

/** Control characters cannot appear in a path a human means to share, and are
 *  the classic way to hide what a string actually says. TAB is excluded from
 *  the tolerance the collab_path validator grants it: that leniency exists so a
 *  stored value round-trips, not so a tab reaches the shell. */
const CONTROL_CHARACTERS = /\p{Cc}/u;

/**
 * macOS packages: directories that LaunchServices treats as a single openable
 * item. `.app` is the one that matters — the rest are here because they are
 * also bundles the OS will happily act on, and an allow-nothing list is the
 * side to be wrong on.
 */
const BUNDLE_EXTENSION =
  /\.(app|pkg|mpkg|bundle|plugin|kext|framework|prefpane|qlgenerator|saver|component|service|workflow|action|wdgt|scptd|appex)$/i;

export type OpenLocalPathResult =
  | { ok: true; action: "opened" | "revealed" }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "error";
      error?: string;
    };

/** POSIX (`/…`), UNC (`\\host\share`) or a Windows drive (`Z:\…`, `Z:/…`).
 *  Mirrors isAbsoluteCollabPath in packages/core/projects/collab-path.ts and
 *  the server's own check — a relative path has no meaning without a working
 *  directory, and this process has one the reader never chose. */
function isAbsolute(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("\\\\")) return true;
  if (path.length >= 3 && path[1] === ":" && (path[2] === "/" || path[2] === "\\")) {
    return /^[A-Za-z]$/.test(path[0] ?? "");
  }
  return false;
}

function isBundle(path: string): boolean {
  // Trailing separators would hide the extension from basename on POSIX.
  const trimmed = path.replace(/[\\/]+$/, "");
  return BUNDLE_EXTENSION.test(basename(trimmed));
}

export async function openLocalPathSafely(
  rawPath: unknown,
): Promise<OpenLocalPathResult> {
  if (typeof rawPath !== "string") return { ok: false, reason: "invalid" };
  const path = rawPath.trim();
  if (!path) return { ok: false, reason: "invalid" };
  if (Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) {
    return { ok: false, reason: "invalid" };
  }
  if (CONTROL_CHARACTERS.test(path)) return { ok: false, reason: "invalid" };
  if (!isAbsolute(path)) return { ok: false, reason: "invalid" };

  let isDirectory: boolean;
  try {
    // stat, not lstat: a symlink to a directory is a directory as far as the
    // reader is concerned, and resolving it is also what keeps a link pointing
    // at a bundle from slipping past the extension check below — the name we
    // test is the one the user clicked either way.
    isDirectory = (await stat(path)).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, reason: "not_found" };
    }
    return {
      ok: false,
      reason: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (isDirectory && !isBundle(path)) {
    // Returns "" on success, an error string otherwise.
    const error = await shell.openPath(path);
    if (error === "") return { ok: true, action: "opened" };
    return { ok: false, reason: "error", error };
  }

  shell.showItemInFolder(path);
  return { ok: true, action: "revealed" };
}
