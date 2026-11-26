"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen } from "@multica/ui/icons";
import { toast } from "sonner";
import { copyText } from "@multica/ui/lib/clipboard";
import { cn } from "@multica/ui/lib/utils";
import { useConfigStore } from "@multica/core/config";
import { collabPathAddresses } from "@multica/core/projects/collab-path";
import {
  canOpenLocalPath,
  openLocalPath,
  viewerFileManager,
} from "../platform/open-local-path";
import { useT } from "../i18n";

/**
 * How long a browser waits for the desktop shell to take over after a custom
 * scheme launch. A registered handler blurs the window within a frame or two;
 * an unregistered scheme does nothing at all, and the browser reports no error.
 * Exported so the tests can drive it with fake timers instead of real waiting.
 */
export const DESKTOP_SHELL_HANDOFF_TIMEOUT_MS = 1200;

/**
 * A filesystem path the reader can act on.
 *
 * Rendered wherever a path appears: the collaboration space on a project, and
 * every path the readonly markdown renderer detects in a description, a comment
 * or a chat message. One component so the two never disagree about what a click
 * does.
 *
 * What a click does is decided by the shell, not by this component's caller:
 *
 *   Desktop — opens the directory in Finder / Explorer through the preload
 *     bridge. One click, always.
 *   Browser, shared storage configured — hands a `bayclaw-open://` URL to the
 *     OS, which the BayClaw Desktop Shell registers. A page served over http(s)
 *     may not navigate to `file://`, but a custom scheme is not blocked: when
 *     the shell is installed it opens the same directory natively. When it is
 *     not installed the OS declines silently, so after a short wait the path is
 *     copied with guidance to install the shell. Either way the reader ends up
 *     with something that works, in their own OS terms.
 *   Anything else — copies the path and names, in the reader's own OS terms,
 *     where to paste it.
 *
 * The path is rendered LTR and monospaced. Its segments are frequently Chinese,
 * and the bidi algorithm will otherwise reorder the separators around a CJK run
 * — producing a path that reads correctly character by character but names a
 * different directory.
 */
/** What a click does to a path, in one place: the component below and the
 *  plan row's "open folder" action must not drift about the shell fallbacks. */
export function useLocalPathActions() {
  const { t } = useT("common");
  const collabSpaceHost = useConfigStore((state) => state.collabSpaceHost);

  // At most one handoff is in flight. A double click cancels the previous
  // attempt before starting the next, so listeners and timers cannot stack, and
  // unmounting mid-wait cannot resolve a toast onto a page the reader left.
  const cancelHandoff = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      cancelHandoff.current?.();
      cancelHandoff.current = null;
    },
    [],
  );

  const copyWithHint = async (path: string) => {
    const ok = await copyText(path);
    if (!ok) {
      toast.error(t(($) => $.local_path.toast_copy_failed));
      return;
    }
    const manager = viewerFileManager();
    toast.success(
      manager === "finder"
        ? t(($) => $.local_path.toast_copied_finder)
        : manager === "explorer"
          ? t(($) => $.local_path.toast_copied_explorer)
          : t(($) => $.local_path.toast_copied_generic),
    );
  };

  const open = async (path: string) => {
    const addresses = collabPathAddresses(path, collabSpaceHost);

    if (canOpenLocalPath()) {
      // Inside the shell the bridge is the whole story: it resolves the mount
      // and opens it with the full parent hierarchy, which no protocol URL or
      // file-server address can do as well.
      cancelHandoff.current?.();
      cancelHandoff.current = null;
      const result = await openLocalPath(path);
      if (result.ok) return;
      // `not_found` is the unmounted-volume case and `untrusted_host` the one
      // the shell's own whitelist refused: the value is still correct for the
      // machine that wrote it, so hand it over rather than dead-ending.
      if (result.reason === "not_found") {
        await copyText(path);
        toast.error(t(($) => $.local_path.toast_not_found));
        return;
      }
      if (result.reason === "untrusted_host") {
        await copyText(path);
        toast.error(t(($) => $.local_path.toast_untrusted_host));
        return;
      }
      if (result.reason === "unsupported") {
        await copyWithHint(path);
        return;
      }
      // `invalid`, `untrusted_origin` and transport errors: the path never
      // reached a file manager, and copying it would imply otherwise.
      toast.error(t(($) => $.local_path.toast_failed));
      return;
    }

    const manager = viewerFileManager();

    // Non-null exactly when the deployment configured a file server AND the
    // path names a share on it — the trust decision already happened in
    // `collabPathAddresses`, so nothing here has to re-derive a host.
    if (addresses.desktopShellUrl !== null) {
      // A POSIX path is meaningless in Explorer, so Windows gets the UNC form.
      const fallbackPath =
        manager === "explorer" && addresses.uncPath ? addresses.uncPath : path;
      cancelHandoff.current?.();
      cancelHandoff.current = startDesktopShellHandoff(
        addresses.desktopShellUrl,
        {
          onOpened: () => {
            cancelHandoff.current = null;
            void copyText(fallbackPath);
            toast.success(
              t(($) => $.local_path.toast_opening_desktop_shell),
            );
          },
          onTimeout: () => {
            cancelHandoff.current = null;
            void (async () => {
              const ok = await copyText(fallbackPath);
              if (!ok) {
                toast.error(t(($) => $.local_path.toast_copy_failed));
                return;
              }
              toast.success(
                manager === "finder"
                  ? t(($) => $.local_path.toast_shell_not_installed_finder)
                  : manager === "explorer"
                    ? t(($) => $.local_path.toast_shell_not_installed_explorer)
                    : t(($) => $.local_path.toast_shell_not_installed_generic),
              );
            })();
          },
        },
      );
      return;
    }

    // No file server, a UNC path naming some other server, or a path whose
    // share cannot be derived: the clipboard is the whole available action.
    await copyWithHint(path);
  };

  const copy = (path: string) => copyWithHint(path);
  return { open, copy };
}

export function LocalPathLink({
  path,
  children,
  className,
  wrap = "break",
}: {
  path: string;
  /** Visible text, when it differs from the path (a markdown link label). */
  children?: React.ReactNode;
  className?: string;
  /**
   * How the path behaves when it does not fit. `break` wraps it across lines,
   * which is right inside prose. `truncate` clips it to one line for a fixed
   * column such as a property sidebar, where wrapping a NAS path would push
   * every row below it off screen.
   */
  wrap?: "break" | "truncate";
}) {
  const { t } = useT("common");
  const collabSpaceHost = useConfigStore((state) => state.collabSpaceHost);
  const addresses = useMemo(
    () => collabPathAddresses(path, collabSpaceHost),
    [path, collabSpaceHost],
  );
  // Resolved after mount: both the desktop bridge and the user agent live on
  // `window`, and reading either during render would make the server-rendered
  // HTML disagree with the first client render. `false` is the SSR answer and
  // also the conservative one.
  const [canOpen, setCanOpen] = useState(false);
  useEffect(() => {
    // A browser with a share address has an action too: the handoff either
    // opens the directory in the installed shell or leaves the path on the
    // clipboard with install guidance.
    setCanOpen(canOpenLocalPath() || addresses.desktopShellUrl !== null);
  }, [addresses.desktopShellUrl]);

  const actions = useLocalPathActions();
  const handleClick = () => actions.open(path);

  return (
    <button
      type="button"
      dir="ltr"
      // The accessible name is the path itself — the same contract every other
      // link in rendered content uses. `title` carries what the click does,
      // which differs by shell and is therefore not something the name can
      // promise.
      // Clipped text has to be readable somehow, and the tooltip is the only
      // place left; where the path is fully visible the tooltip is free to say
      // what the click does instead.
      title={
        wrap === "truncate"
          ? path
          : canOpen
            ? t(($) => $.local_path.action_open)
            : t(($) => $.local_path.action_copy)
      }
      data-local-path=""
      className={cn(
        "inline-flex max-w-full items-baseline gap-1 rounded-xs text-left align-baseline",
        "font-mono underline decoration-dotted underline-offset-2",
        "text-foreground hover:decoration-solid transition-colors",
        wrap === "truncate" && "min-w-0",
        className,
      )}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void handleClick();
      }}
    >
      <FolderOpen
        aria-hidden
        className="size-[1em] shrink-0 self-center text-muted-foreground"
      />
      <span className={wrap === "truncate" ? "min-w-0 truncate" : "break-all"}>
        {children ?? path}
      </span>
    </button>
  );
}

/**
 * Launch a `bayclaw-open://` URL and watch for the shell taking over.
 *
 * The launch itself is not observable: an anchor click either reaches a
 * registered handler or is declined in silence, with nothing reported back to
 * script. What IS observable is the window losing focus, which a real shell
 * causes as it comes forward. So the click is paired with a short wait: `blur`
 * (or the document becoming hidden) means the shell answered, and silence for
 * `DESKTOP_SHELL_HANDOFF_TIMEOUT_MS` means it is not installed.
 *
 * Returns a cancel function: it settles silently, for a newer click that
 * supersedes this attempt or an unmount, so no listener or timer is left
 * behind.
 */
function startDesktopShellHandoff(
  url: string,
  handlers: { onOpened: () => void; onTimeout: () => void },
): () => void {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    window.removeEventListener("blur", handleBlur);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const settle = (next: () => void) => {
    if (settled) return;
    settled = true;
    cleanup();
    next();
  };

  function handleBlur() {
    settle(handlers.onOpened);
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "hidden") settle(handlers.onOpened);
  }

  // Listeners before the launch: a browser may blur the window during the very
  // click that starts it, and registering afterwards would miss that.
  window.addEventListener("blur", handleBlur);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  timer = setTimeout(
    () => settle(handlers.onTimeout),
    DESKTOP_SHELL_HANDOFF_TIMEOUT_MS,
  );

  handOffToOS(url);

  return () => settle(() => {});
}

/**
 * Hand a non-web URL to the operating system.
 *
 * A synthetic anchor click rather than assigning `location.href`: an
 * unregistered scheme assigned to `location` can leave the page in a
 * half-navigated state in some browsers, while an anchor that the OS declines
 * simply does nothing. Either way the outcome is not observable from script,
 * which is why every caller pairs this with a fallback.
 */
function handOffToOS(url: string): void {
  if (typeof document === "undefined") return;
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
