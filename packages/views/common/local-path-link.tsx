"use client";

import { useEffect, useMemo, useState } from "react";
import { FolderOpen } from "lucide-react";
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
 *   Browser on macOS, shared storage configured — hands an `smb://` URL to the
 *     OS, which is Finder. Also one click. `file://` is blocked outright in
 *     every browser with no permission to grant, but a custom scheme is not:
 *     the same directory addressed through the file server it actually lives on
 *     goes straight to Finder, mounting the share on the way if needed.
 *   Browser on Windows, shared storage configured — copies the UNC form, which
 *     is what Explorer's address bar accepts. Windows registers no `smb:`
 *     handler, so the clipboard is the end of the line there; what changes is
 *     that the copied value works when pasted, instead of being a POSIX path
 *     from someone else's Mac.
 *   Anything else — copies the path and names, in the reader's own OS terms,
 *     where to paste it.
 *
 * The path is rendered LTR and monospaced. Its segments are frequently Chinese,
 * and the bidi algorithm will otherwise reorder the separators around a CJK run
 * — producing a path that reads correctly character by character but names a
 * different directory.
 */
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
    setCanOpen(
      canOpenLocalPath() ||
        (viewerFileManager() === "finder" && addresses.smbUrl !== null),
    );
  }, [addresses.smbUrl]);

  const copyWithHint = async () => {
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

  const openFromBrowser = async () => {
    const manager = viewerFileManager();
    if (manager === "finder" && addresses.smbUrl) {
      handOffToOS(addresses.smbUrl);
      // Best-effort safety net. Whether the OS actually took the URL is not
      // observable from here, so the path goes on the clipboard too: if
      // nothing opens, the reader still has something to paste rather than a
      // click that did nothing.
      void copyText(path);
      toast.success(t(($) => $.local_path.toast_opening_finder));
      return;
    }
    if (manager === "explorer" && addresses.uncPath) {
      // The UNC form, not the stored path: the stored one names a mount point
      // on somebody else's Mac and pasting it into Explorer finds nothing.
      const ok = await copyText(addresses.uncPath);
      toast[ok ? "success" : "error"](
        ok
          ? t(($) => $.local_path.toast_copied_unc)
          : t(($) => $.local_path.toast_copy_failed),
      );
      return;
    }
    await copyWithHint();
  };

  const handleClick = async () => {
    // Probed at click time rather than read from state: a click is never part
    // of the first render, so this is the freshest answer and it keeps the
    // action correct even if the effect above has not run.
    if (!canOpenLocalPath()) {
      await openFromBrowser();
      return;
    }
    const result = await openLocalPath(path);
    if (result.ok) return; // A file-manager window is now on screen.
    if (result.reason === "not_found") {
      // The overwhelmingly common cause is an unmounted share, not a typo:
      // the path is correct on the machine that wrote it and this one has not
      // connected the volume. Say that, and leave the path on the clipboard so
      // the reader can act on it after mounting.
      await copyText(path);
      toast.error(t(($) => $.local_path.toast_not_found));
      return;
    }
    if (result.reason === "unsupported") {
      await copyWithHint();
      return;
    }
    toast.error(t(($) => $.local_path.toast_failed));
  };

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
