"use client";

import { useEffect, useState } from "react";
import { KeyRound, RotateCw } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import type { GalleryScreen, GalleryWork } from "./gallery-catalog";
import { PrototypeFrame } from "./prototype-frame";

interface PrototypeViewerProps {
  work: GalleryWork | null;
  /** Screen to open on. Ignored once the viewer is open and the user switches. */
  initialScreenId?: string;
  onClose: () => void;
}

/**
 * Near-fullscreen viewer for one delivered work: a screen switcher across the
 * top, the live prototype below.
 */
export function PrototypeViewer({ work, initialScreenId, onClose }: PrototypeViewerProps) {
  const { t } = useT("gallery");
  const [activeId, setActiveId] = useState(initialScreenId);
  const [reloadToken, setReloadToken] = useState(0);

  // Re-seed whenever the caller opens the viewer on a different screen. The
  // state has to live here (not in the parent) so switching tabs inside the
  // viewer does not read as the parent re-opening it.
  useEffect(() => {
    setActiveId(initialScreenId);
    setReloadToken(0);
  }, [initialScreenId, work?.id]);

  if (!work) return null;

  const screens = work.screens;
  const active: GalleryScreen | undefined =
    screens.find((screen) => screen.id === activeId) ?? screens[0];
  if (!active) return null;

  const frameTitle = `${work.name} · ${active.name}`;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton
        className="flex h-[min(92vh,calc(100dvh-2rem))] w-[calc(100vw-2rem)] max-w-[1600px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1600px]"
      >
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3 pr-12">
          <div className="min-w-0">
            <DialogTitle className="truncate text-body font-medium">{frameTitle}</DialogTitle>
            <DialogDescription className="truncate text-caption text-muted-foreground">
              {active.summary}
            </DialogDescription>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {active.credentials ? (
              <span className="hidden items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-caption text-muted-foreground lg:inline-flex">
                <KeyRound aria-hidden="true" className="size-3.5" />
                {t(($) => $.viewer.credentials, {
                  account: active.credentials.account,
                  password: active.credentials.password,
                })}
              </span>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 gap-1.5"
              onClick={() => setReloadToken((token) => token + 1)}
            >
              <RotateCw aria-hidden="true" className="size-3.5" />
              <span className="hidden md:inline">{t(($) => $.viewer.reload)}</span>
            </Button>
          </div>

          {screens.length > 1 ? (
            <div
              role="tablist"
              aria-label={t(($) => $.viewer.screens_label)}
              className="flex w-full flex-wrap items-center gap-1"
            >
              {screens.map((screen) => {
                const isActive = screen.id === active.id;
                return (
                  <button
                    key={screen.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    data-active={isActive || undefined}
                    onClick={() => setActiveId(screen.id)}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-caption transition-colors",
                      // The selected chip carries weight and foreground colour,
                      // neither of which hover touches — so hovering the active
                      // chip cannot visually demote it to a plain hover state.
                      "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      "data-active:bg-accent data-active:font-medium data-active:text-foreground",
                    )}
                  >
                    {screen.name}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        <div className="min-h-0 flex-1">
          <PrototypeFrame screen={active} title={frameTitle} reloadToken={reloadToken} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
