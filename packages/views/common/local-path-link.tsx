"use client";

import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { copyText } from "@multica/ui/lib/clipboard";
import { cn } from "@multica/ui/lib/utils";
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
 *   Desktop — opens the directory in Finder / Explorer.
 *   Browser — copies the path and names, in the reader's own OS terms, where to
 *     paste it. A browser cannot open a local directory: navigating an http(s)
 *     page to `file://` is blocked outright, with no permission to grant. The
 *     clipboard is the whole of what is available, so it is offered as the
 *     action rather than hidden behind a menu.
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
  // Resolved after mount: the capability lives on `window`, and reading it
  // during render would make the server-rendered HTML disagree with the first
  // client render. `false` is the web answer, which is also the SSR answer.
  const [canOpen, setCanOpen] = useState(false);
  useEffect(() => setCanOpen(canOpenLocalPath()), []);

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

  const handleClick = async () => {
    // Probed at click time rather than read from state: a click is never part
    // of the first render, so this is the freshest answer and it keeps the
    // action correct even if the effect above has not run.
    if (!canOpenLocalPath()) {
      await copyWithHint();
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
        "font-mono text-[0.95em] underline decoration-dotted underline-offset-2",
        "text-foreground/90 hover:text-foreground hover:decoration-solid transition-colors",
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
