/**
 * Opening a local filesystem path from the app.
 *
 * What is possible here depends entirely on which shell the renderer runs in,
 * and the gap is not a detail the UI can paper over:
 *
 *   Desktop (Electron) — `shell.openPath` through the preload bridge. One
 *     click puts a Finder / Explorer window on screen. Real.
 *
 *   Web (any browser) — impossible. A page served over http(s) may not
 *     navigate to `file://`; Chrome, Firefox, Safari and Edge all block the
 *     click, silently, with no permission a user can grant. This is not a gap
 *     in this module, and no amount of markup works around it. The honest
 *     fallback is to put the path on the clipboard and say, in the reader's own
 *     OS terms, where to paste it — which is what the calling component does.
 *
 * So `canOpenLocalPath()` is the switch every caller branches on, and it
 * answers a capability question, not a preference.
 */

export type OpenLocalPathResult =
  | { ok: true; action: "opened" | "revealed" }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "error" | "unsupported";
      error?: string;
    };

interface DesktopLocalPathAPI {
  openLocalPath?: (path: string) => Promise<OpenLocalPathResult>;
}

function readDesktopAPI(): DesktopLocalPathAPI | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { desktopAPI?: DesktopLocalPathAPI }).desktopAPI;
}

/**
 * True when this shell can put a file-manager window on screen.
 *
 * Probes the bridge itself rather than sniffing for Electron: a desktop build
 * older than this feature is running the same renderer code but has no
 * `openLocalPath` in its preload, and it must take the web fallback rather than
 * calling into a channel its main process never registered.
 */
export function canOpenLocalPath(): boolean {
  return typeof readDesktopAPI()?.openLocalPath === "function";
}

export async function openLocalPath(path: string): Promise<OpenLocalPathResult> {
  const api = readDesktopAPI();
  if (!api?.openLocalPath) return { ok: false, reason: "unsupported" };
  try {
    return await api.openLocalPath(path);
  } catch (err) {
    return {
      ok: false,
      reason: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Which file manager the reader is looking at, for copy that names it. Only
 *  ever decides wording — never whether something is attempted — so a wrong
 *  guess on an unusual browser costs a slightly generic sentence. */
export type ViewerFileManager = "finder" | "explorer" | "unknown";

export function viewerFileManager(): ViewerFileManager {
  if (typeof navigator === "undefined") return "unknown";
  // userAgentData is the non-deprecated source where it exists; userAgent is
  // the fallback every browser still carries.
  const hinted = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData?.platform;
  const value = `${hinted ?? ""} ${navigator.userAgent ?? ""}`.toLowerCase();
  // iPadOS reports a Mac user agent, but it has no Finder a path can be pasted
  // into, so the touch check keeps it on the generic wording.
  const touchOnly = navigator.maxTouchPoints > 1 && /mac/.test(value);
  if (/win/.test(value)) return "explorer";
  if (/mac/.test(value) && !touchOnly) return "finder";
  return "unknown";
}
