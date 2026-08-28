"use client";

import { useEffect, useRef, useState } from "react";
import { SCENE_H, SCENE_W } from "./office-view";
import type { OfficeTranslate } from "./office-i18n";

// The little popover that opens above the viewer's own head: pick a preset
// or type something custom. It is plain absolutely-positioned HTML over the
// scene (not SVG) because it needs a real input; the anchor is passed in
// scene units and converted to percentages, so it tracks the fluid-width
// svg without any measurement.

/** Preset keys under `status.presets` in the office bundle. The localized
 * label is also the stored status text — a preset is just a shortcut for
 * typing it. */
export const STATUS_PRESET_KEYS = [
  "focus",
  "meeting",
  "gym",
  "coffee",
  "away",
  "vacation",
] as const;

export interface OfficeStatusEditorProps {
  /** Anchor point in scene units (the pill's top centre). */
  anchor: { x: number; y: number };
  current: string;
  t: OfficeTranslate;
  /** Fired with the new status text; "" clears. */
  onSave: (status: string) => void;
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

  const save = (status: string) => {
    onSave(status.trim());
    onClose();
  };

  return (
    <div
      ref={rootRef}
      className="absolute z-10 w-60 -translate-x-1/2 -translate-y-full rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg"
      style={{
        left: `${(anchor.x / SCENE_W) * 100}%`,
        top: `${(anchor.y / SCENE_H) * 100}%`,
      }}
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
            onClick={() => save(t(`status.presets.${key}`))}
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
