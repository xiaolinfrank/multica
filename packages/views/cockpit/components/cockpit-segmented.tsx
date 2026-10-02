"use client";

// The gliding pill behind the cockpit's segmented controls (page tabs, the
// register's view switch). The buttons carry no active background of their
// own — one pill element slides to whichever button is active, so a switch
// reads as the same object moving rather than two states blinking over.

import { useCallback, useLayoutEffect, useState } from "react";

/**
 * Measures the `[data-active="true"]` child and publishes its geometry as the
 * custom properties the pill's CSS reads. Re-runs when the active key changes
 * and whenever the container resizes (window, font load, locale switch).
 */
export function useSegmentedPill(active: string) {
  // The control can mount after an initial loading render while `active` stays
  // unchanged. A plain object ref would leave the effect stranded after its
  // first null read; a callback ref promotes mounting itself to a dependency.
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => setElement(node), []);

  useLayoutEffect(() => {
    if (!element) return;
    const update = () => {
      const button = element.querySelector<HTMLButtonElement>('[data-active="true"]');
      if (!button) {
        element.style.setProperty("--pill-on", "0");
        return;
      }
      element.style.setProperty("--pill-left", `${button.offsetLeft}px`);
      element.style.setProperty("--pill-width", `${button.offsetWidth}px`);
      element.style.setProperty("--pill-on", "1");
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, element]);
  return ref;
}

/** The pill itself — paint only, never interactive. */
export function SegmentedPill() {
  return <span aria-hidden className="cockpit-segmented-pill" />;
}
