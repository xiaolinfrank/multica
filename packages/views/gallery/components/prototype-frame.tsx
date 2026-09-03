"use client";

/**
 * The iframe the gallery frames its prototypes in.
 *
 * This is deliberately NOT `HtmlPreviewBody` / `CodeBlockIframe`. Those exist
 * for *untrusted* HTML — attachment bodies and model-authored code blocks —
 * and so pin `sandbox="allow-scripts"` without `allow-same-origin`, which
 * leaves the framed document on an opaque origin. Four of the seven gallery
 * documents call `localStorage.setItem` unguarded on sign-in, and on an
 * opaque origin that throws a SecurityError and the demo dies at the login
 * screen. They are also served from a URL rather than as a `srcDoc` string.
 *
 * These documents are first-party: committed to this repo, reviewed, entirely
 * self-contained (no network calls, no external URLs) and carrying no `target=`
 * attribute — every anchor in them is either `javascript:;` or an in-page
 * fragment — so they cannot navigate the shell away. That is the same
 * posture plugins/plugin-surface-frame.tsx takes for its host-authored
 * wrapper, and the sandbox still buys us blocked top-level navigation.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@multica/ui/lib/utils";
import type { GalleryScreen } from "./gallery-catalog";
import { galleryAssetSrc } from "./gallery-asset-src";

/**
 * Kept in step with the trust note above: scripts and a real origin (so
 * storage works), but no `allow-top-navigation`, so a prototype can never
 * replace the app shell.
 */
const PROTOTYPE_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals";

interface PrototypeFrameProps {
  screen: GalleryScreen;
  title: string;
  className?: string;
  /** Bump to force a fresh document — the viewer's "reload" affordance. */
  reloadToken?: number;
}

/** Full-size, interactive prototype. */
export function PrototypeFrame({ screen, title, className, reloadToken = 0 }: PrototypeFrameProps) {
  return (
    <iframe
      // Remounting on reload is the point: a prototype keeps all its state in
      // the document, so a new document is the only honest "start over".
      key={`${screen.id}-${reloadToken}`}
      src={galleryAssetSrc(screen.id)}
      title={title}
      sandbox={PROTOTYPE_SANDBOX}
      // The slide deck letters "F 全屏" into its own footer, and a sandboxed
      // frame is denied fullscreen unless the embedder delegates it — the call
      // rejects silently, so the affordance would just look broken. Delegated
      // only here: a thumbnail has no business going fullscreen.
      allow="fullscreen"
      className={cn("h-full w-full border-0 bg-background", className)}
    />
  );
}

/**
 * The viewport width the desktop prototypes were designed against. The
 * thumbnail renders at this width and is then scaled down, so a card preview
 * shows the real desktop layout instead of the prototype's narrow reflow.
 */
const THUMBNAIL_VIEWPORT_WIDTH = 1440;
const THUMBNAIL_VIEWPORT_HEIGHT = 900;

interface PrototypeThumbnailProps {
  screen: GalleryScreen;
  title: string;
  className?: string;
}

/**
 * A live, inert miniature of a prototype used as a card cover.
 *
 * The frame is laid out at a fixed desktop viewport and scaled to fit its
 * container, because an iframe's layout viewport is its CSS box: letting it be
 * card-width would trigger the prototype's own mobile breakpoints and show a
 * layout the delivered product never has.
 */
export function PrototypeThumbnail({ screen, title, className }: PrototypeThumbnailProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0);

  const measure = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const { width } = host.getBoundingClientRect();
    if (width > 0) setScale(width / THUMBNAIL_VIEWPORT_WIDTH);
  }, []);

  useEffect(() => {
    measure();
    // jsdom has no ResizeObserver; the one measure() above is enough there and
    // in any browser that never resizes the card.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    const host = hostRef.current;
    if (host) observer.observe(host);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div ref={hostRef} className={cn("relative overflow-hidden bg-surface", className)}>
      {scale > 0 ? (
        <iframe
          src={galleryAssetSrc(screen.id)}
          title={title}
          aria-hidden="true"
          tabIndex={-1}
          scrolling="no"
          // A cover is decoration, and the documents behind these run from 70 KB
          // to 5 MB — the overview carries nine embedded photographs, the JIA
          // deck three 4K slides — so the catalogue should not fetch every one
          // of them to paint thumbnails
          // nobody has scrolled to. The hint is not a guarantee: browsers load
          // lazily-flagged frames well before they enter the viewport, so the
          // first card's document is still likely to be fetched on arrival. It
          // is the cards further down this saves. The full-size `PrototypeFrame`
          // stays eager — that one the reader asked for.
          loading="lazy"
          sandbox={PROTOTYPE_SANDBOX}
          className="pointer-events-none absolute top-0 left-0 origin-top-left border-0"
          style={{
            width: THUMBNAIL_VIEWPORT_WIDTH,
            height: THUMBNAIL_VIEWPORT_HEIGHT,
            transform: `scale(${scale})`,
          }}
        />
      ) : null}
    </div>
  );
}
