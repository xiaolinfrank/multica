// Client-side mirror of the server's collab_path validation
// (server/internal/handler/collab_path.go). The path is a project-level field
// — a module's deliverables live in a folder named after it inside the
// project's space, with no separate value to validate — so this lives beside
// the project contract rather than inside one UI surface; every project
// surface (web, desktop) imports it from here.
//
// The point of validating here is not to replace the server check — the server
// still answers 400 and is the authority — but to name the one mistake users
// actually make (typing a path relative to their own machine) in the field
// where they made it, instead of surfacing a raw API error in a toast.

/** Maximum stored length, in UTF-8 bytes. The server bounds `len(trimmed)`,
 *  which counts bytes, so a Chinese path hits the ceiling roughly three times
 *  sooner than its character count suggests. Counting characters here would
 *  let a value through that the server then rejects. */
export const COLLAB_PATH_MAX_BYTES = 1024;

export type CollabPathError =
  /** Longer than COLLAB_PATH_MAX_BYTES once trimmed. */
  | "too_long"
  /** Contains a control character other than TAB. */
  | "control_characters"
  /** Not a POSIX, UNC or Windows-drive absolute path. */
  | "not_absolute";

export type CollabPathResult =
  /** `value` is the trimmed path, or null when the input clears the field. */
  | { ok: true; value: string | null }
  | { ok: false; reason: CollabPathError };

/** UTF-8 byte length without allocating an encoder: keeps this module free of
 *  any platform global so it stays usable from a node test, a browser and a
 *  React Native bundle alike. */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/** TAB is the one control character the server tolerates (a path may legally
 *  contain one); everything else in Unicode category Cc is a paste accident. */
const FORBIDDEN_CONTROL = /[\p{Cc}]/u;

/**
 * Absolute forms a daemon host can mount, matching isAbsoluteCollabPath on the
 * server: POSIX (`/Volumes/...`), UNC (`\\nas\share\...`) and a Windows drive
 * (`Z:/...` or `Z:\...`). Daemons run on macOS, Linux and Windows, so pinning
 * the check to one separator would reject a value that is correct on another.
 */
export function isAbsoluteCollabPath(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("\\\\")) return true;
  if (path.length >= 3 && path[1] === ":" && (path[2] === "/" || path[2] === "\\")) {
    return /^[A-Za-z]$/.test(path[0] ?? "");
  }
  return false;
}

/**
 * Trims and validates a human-agent collaboration space path
 * ("人机协作空间路径").
 *
 * A blank value means "no path" and resolves to null, which callers send as an
 * explicit null to clear the column — the update contract reads an absent key
 * as "keep the current value", so a cleared field must still be sent.
 */
export function normalizeCollabPath(raw: string): CollabPathResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (utf8ByteLength(trimmed) > COLLAB_PATH_MAX_BYTES) {
    return { ok: false, reason: "too_long" };
  }
  if (FORBIDDEN_CONTROL.test(trimmed.replace(/\t/g, ""))) {
    return { ok: false, reason: "control_characters" };
  }
  if (!isAbsoluteCollabPath(trimmed)) {
    return { ok: false, reason: "not_absolute" };
  }
  return { ok: true, value: trimmed };
}

// ---------------------------------------------------------------------------
// Addressing the same directory from a reader's machine
// ---------------------------------------------------------------------------

/**
 * A collaboration space is stored as the path the AGENT's machine mounts, and
 * that string is useless to a reader's browser: an http(s) page may not
 * navigate to `file://`, in any browser, with no permission a user can grant.
 *
 * The directory itself is reachable, though — it is on a file server both
 * machines can see. Given that server's host (the deployment's
 * `collab_space_host`), the same location has two addresses that do work:
 *
 *   smb://host/share/…   macOS hands this to Finder, so a click opens it
 *   \\host\share\…       what Windows Explorer accepts in its address bar
 *
 * Deriving them requires knowing which part of the path is the share name.
 * Only two forms answer that. A UNC path carries the host and share itself, so
 * it needs no configuration at all. And macOS mounts a share at
 * `/Volumes/<share name>`, so the first segment under `/Volumes` IS the share.
 *
 * Everything else returns nothing, deliberately. A Linux `/mnt/<anything>` is
 * named by whoever wrote the fstab entry and a `Z:\…` drive letter hides the
 * share behind a per-machine mapping; guessing either would produce an address
 * that fails in a way the reader cannot diagnose, which is worse than the
 * clipboard.
 */
export interface CollabPathAddresses {
  /** Opens in Finder on macOS. `null` when the share cannot be identified. */
  smbUrl: string | null;
  /** Paste-able in the Windows Explorer address bar. */
  uncPath: string | null;
}

const NONE: CollabPathAddresses = { smbUrl: null, uncPath: null };

const MACOS_MOUNT_ROOT = "/Volumes/";

/** Percent-encodes each segment while leaving the separators alone. macOS
 *  writes its own mount URLs this way, so Finder decodes them back. */
function encodeSmbPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function collabPathAddresses(
  path: string,
  host: string,
): CollabPathAddresses {
  const value = path.trim();
  if (!value) return NONE;

  // A UNC path already names its own server. Nothing to configure, and the
  // deployment's host is irrelevant — this path may well name a different one.
  if (value.startsWith("\\\\")) {
    const rest = value.slice(2).replace(/\\/g, "/");
    const [uncHost, ...segments] = rest.split("/").filter(Boolean);
    // `\\host` alone is a server, not a directory.
    if (!uncHost || segments.length === 0) return NONE;
    return {
      smbUrl: `smb://${uncHost}/${encodeSmbPath(segments.join("/"))}`,
      uncPath: value.replace(/\//g, "\\"),
    };
  }

  const server = host.trim();
  if (!server) return NONE;
  if (!value.startsWith(MACOS_MOUNT_ROOT)) return NONE;
  const rest = value.slice(MACOS_MOUNT_ROOT.length);
  // `/Volumes/` alone names the mount root, not a share.
  if (!rest || rest.startsWith("/")) return NONE;

  return {
    smbUrl: `smb://${server}/${encodeSmbPath(rest)}`,
    uncPath: `\\\\${server}\\${rest.replace(/\//g, "\\")}`,
  };
}
