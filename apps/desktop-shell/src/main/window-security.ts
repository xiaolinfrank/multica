import type { ShellConfig } from "../shared/types";
import { isSameServerOrigin } from "../shared/url-protocol";

export type NavigationDecision = "allow" | "external" | "block";

/**
 * Only ordinary web URLs may reach the OS default browser. Everything the OS
 * might hand to an application (file:, smb:) or execute (javascript:, data:,
 * vbscript:) is refused, as is a recursive bayclaw-open: handoff.
 */
export function isSafeExternalUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== "string") return false;
  const value = rawUrl.trim();
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function defaultOpenExternal(url: string): Promise<void> {
  // `electron` is required lazily so unit tests can import this module in a
  // plain Node process without resolving the Electron binary.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require("electron") as typeof import("electron");
  return electron.shell.openExternal(url);
}

/** Opens an external URL only after the scheme allowlist accepts it. */
export async function openExternalSafely(
  rawUrl: string,
  openExternalFn?: (url: string) => Promise<void>,
): Promise<boolean> {
  if (!isSafeExternalUrl(rawUrl)) return false;
  const opener = openExternalFn ?? defaultOpenExternal;
  try {
    await opener(rawUrl);
    return true;
  } catch {
    return false;
  }
}

/**
 * The self-signed credential opt-in is scoped to the exact host the user
 * configured. A certificate error for any other host is never suppressed.
 */
export function shouldTrustCertificateError(
  failingUrl: string,
  config: Pick<ShellConfig, "serverUrl" | "allowSelfSignedCert">,
): boolean {
  if (config.allowSelfSignedCert !== true) return false;
  try {
    return new URL(failingUrl).host === new URL(config.serverUrl).host;
  } catch {
    return false;
  }
}

/** IPC may only act for a frame served by the configured origin. */
export function isTrustedWebOrigin(
  senderUrl: string | undefined | null,
  serverUrl: string,
): boolean {
  return isSameServerOrigin(senderUrl, serverUrl);
}

/**
 * Decides what to do with a navigation attempt: same-origin stays inside the
 * shell, other web URLs go to the OS browser, everything else is blocked.
 */
export function decideNavigation(
  targetUrl: string,
  serverUrl: string,
): NavigationDecision {
  if (isSameServerOrigin(targetUrl, serverUrl)) return "allow";
  if (isSafeExternalUrl(targetUrl)) return "external";
  return "block";
}
