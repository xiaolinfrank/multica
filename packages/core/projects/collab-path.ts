// Client-side mirror of the server's collab_path validation
// (server/internal/handler/collab_path.go). Both projects and modules carry
// the field, so this lives beside the project contract rather than inside one
// UI surface; the module surfaces import it from here.
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
