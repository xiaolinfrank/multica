"use client";

import { useEffect, useRef, useState } from "react";
import type { OfficeTranslate } from "./office-i18n";

// The little popover that opens above the viewer's own head: pick a preset
// or type something custom. It is plain absolutely-positioned HTML over the
// scene (not SVG) because it needs a real input.
//
// The anchor arrives already in stage pixels, measured off the figure's own
// DOM node at click time. It used to be scene units divided by SCENE_W/H,
// which silently assumed the svg's element box and its viewBox were the same
// rectangle — true only while the svg had no height of its own. Once the
// scene is allowed to fit inside a taller box, preserveAspectRatio centres
// the drawing and that assumption puts the popover somewhere else entirely.

/** Preset keys under `status.presets` in the office bundle. The localized
 * label is also the stored status text — a preset is just a shortcut for
 * typing it. The key rides along to the server (custom_status_key) and is
 * what routes the figure to a floor zone; mirrors STATUS_PRESET_ZONES in
 * core/office and CustomStatusPresetKeys server-side. */
export const STATUS_PRESET_KEYS = [
  "focus",
  "meeting",
  "gym",
  "coffee",
  "vacation",
] as const;

export interface OfficeStatusEditorProps {
  /** Anchor point in stage pixels (the figure's top centre). */
  anchor: { x: number; y: number };
  current: string;
  t: OfficeTranslate;
  /** Fired with the new status text and preset key ("" = free text); "" text clears. */
  onSave: (status: string, key?: string) => void;
  onClose: () => void;
}

export function OfficeStatusEditor({ anchor, current, t, onSave, onClose }: OfficeStatusEditorProps) {
  const [draft, setDraft] = useState(current);
  const rootRef = useRef<HTMLDivElement>(null);

  // Outside-pointer and Escape dismissal. The pill click that opened the
  // editor has already bubbled by the time this effect runs, so only later
  // pointers close it.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
        onClose();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const save = (status: string, key = "") => {
    onSave(status.trim(), status.trim() === "" ? "" : key);
    onClose();
  };

  return (
    <div
      ref={rootRef}
      className="absolute z-10 w-60 -translate-x-1/2 -translate-y-full rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg"
      style={{ left: `${anchor.x}px`, top: `${anchor.y}px` }}
      role="dialog"
      aria-label={t("status.title")}
    >
      <h4 className="text-label font-semibold">{t("status.title")}</h4>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        {STATUS_PRESET_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className="truncate rounded-lg border px-2 py-1.5 text-caption transition-colors hover:bg-accent"
            onClick={() => save(t(`status.presets.${key}`), key)}
            title={t(`status.presets.${key}`)}
          >
            {t(`status.presets.${key}`)}
          </button>
        ))}
      </div>
      <form
        className="mt-2 flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          save(draft);
        }}
      >
        <input
          autoFocus
          className="min-w-0 flex-1 rounded-lg border bg-background px-2 py-1.5 text-caption outline-none focus:ring-2 focus:ring-ring/40"
          placeholder={t("status.placeholder")}
          value={draft}
          maxLength={100}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="submit"
          className="shrink-0 rounded-lg bg-primary px-2.5 py-1.5 text-caption font-medium text-primary-foreground"
        >
          {t("status.save")}
        </button>
      </form>
      {current !== "" ? (
        <button
          type="button"
          className="mt-1.5 w-full rounded-lg px-2 py-1 text-micro text-muted-foreground hover:bg-accent"
          onClick={() => save("")}
        >
          {t("status.clear")}
        </button>
      ) : null}
    </div>
  );
}
