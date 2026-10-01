"use client";

// The gliding pill behind the cockpit's segmented controls (page tabs, the
// register's view switch). The buttons carry no active background of their
// own — one pill element slides to whichever button is active, so a switch
// reads as the same object moving rather than two states blinking over.

import { useLayoutEffect, useRef } from "react";

/**
 * Measures the `[data-active="true"]` child and publishes its geometry as the
 * custom properties the pill's CSS reads. Re-runs when the active key changes
 * and whenever the container resizes (window, font load, locale switch).
 */
export function useSegmentedPill(active: string) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const button = el.querySelector<HTMLButtonElement>('[data-active="true"]');
      if (!button) {
        el.style.setProperty("--pill-on", "0");
        return;
      }
      el.style.setProperty("--pill-left", `${button.offsetLeft}px`);
      el.style.setProperty("--pill-width", `${button.offsetWidth}px`);
      el.style.setProperty("--pill-on", "1");
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [active]);
  return ref;
}

/** The pill itself — paint only, never interactive. */
export function SegmentedPill() {
  return <span aria-hidden className="cockpit-segmented-pill" />;
}
