import type { ShellConfig } from "./types";

/** Custom URL scheme registered by the packaged shell. */
export const PROTOCOL_SCHEME = "bayclaw-open";

/** Upper bound for a deep-linked path; matches the server's collab_path ceiling. */
const MAX_PROTOCOL_PATH_BYTES = 1024;

const CONTROL_CHARACTERS = /\p{Cc}/u;

/** Loopback names that may use plain http during local development. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  const withoutBrackets =
    normalized.startsWith("[") && normalized.endsWith("]")
      ? normalized.slice(1, -1)
      : normalized;
  return LOOPBACK_HOSTNAMES.has(withoutBrackets);
}

/**
 * Accepts `https://` for any host and `http://` only for loopback hosts.
 * Credentials, non-http(s) schemes, and empty hosts are rejected. The result
 * keeps the origin plus an optional base path, without a trailing slash, so a
 * deployment served from a subpath keeps working.
 */
export function normalizeServerUrl(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol !== "https:" && protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (!url.hostname) return null;
  if (protocol === "http:" && !isLoopbackHostname(url.hostname)) return null;

  url.search = "";
  url.hash = "";
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

/** Returns the bare origin of a normalized server URL, or "" when unparsable. */
export function serverOrigin(serverUrl: string): string {
  try {
    return new URL(serverUrl).origin;
  } catch {
    return "";
  }
}

/** Exact origin comparison; null/undefined/garbage candidates never match. */
export function isSameServerOrigin(
  candidateUrl: string | null | undefined,
  serverUrl: string,
): boolean {
  if (!candidateUrl || !serverUrl) return false;
  try {
    return new URL(candidateUrl).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Parses `bayclaw-open://open?path=<encoded path>`.
 *
 * Any other query parameter — `host` in particular — is deliberately ignored:
 * the path is the only input the shell accepts from an external deep link, and
 * the trusted NAS host always comes from configuration.
 */
export function parseBayclawOpenUrl(rawUrl: string): { path: string } | null {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol.toLowerCase() !== `${PROTOCOL_SCHEME}:`) return null;
  if (url.hostname.toLowerCase() !== "open") return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;

  const rawPath = url.searchParams.get("path");
  if (rawPath === null) return null;
  if (CONTROL_CHARACTERS.test(rawPath)) return null;

  const path = rawPath.trim();
  if (!path) return null;
  if (Buffer.byteLength(path, "utf8") > MAX_PROTOCOL_PATH_BYTES) return null;

  return { path };
}

/** Finds the first `bayclaw-open://` argument (Windows cold start / second instance). */
export function extractProtocolUrlFromArgv(argv: readonly string[]): string | null {
  if (!Array.isArray(argv)) return null;
  const prefix = `${PROTOCOL_SCHEME}://`;
  for (const rawArg of argv) {
    if (typeof rawArg !== "string") continue;
    const arg = rawArg.trim().replace(/^["']/, "").replace(/["']$/, "").trim();
    if (arg.toLowerCase().startsWith(prefix)) return arg;
  }
  return null;
}

/** Convenience guard used by tests and callers that only need a boolean. */
export function isValidServerUrl(raw: string): boolean {
  return normalizeServerUrl(raw) !== null;
}

/** Shape of the persisted config, shared with the setup screen. */
export type { ShellConfig };
