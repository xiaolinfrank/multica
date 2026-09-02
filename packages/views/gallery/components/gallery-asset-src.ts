/**
 * Where the gallery's prototype documents live, per platform.
 *
 * The prototypes are large self-contained HTML files (~750 KB together), so
 * they ship as static files an iframe streams on demand rather than as strings
 * bundled into JS. That puts one copy under each platform's own static root:
 *
 *   apps/web/public/gallery/                 -> served at /gallery/<id>.html
 *   apps/desktop/src/renderer/public/gallery -> copied to out/renderer/gallery
 *
 * The two need different `src` forms, and no single expression covers both:
 *
 *   web      document is /{slug}/gallery, so a relative "gallery/x.html" would
 *            resolve to /{slug}/gallery/gallery/x.html. It needs the root-
 *            absolute form.
 *   desktop  the packaged document is file://…/out/renderer/index.html, where
 *            a root-absolute "/gallery/x.html" resolves to file:///gallery/…
 *            and 404s. It needs the document-relative form.
 *
 * The relative form is safe on desktop in dev *and* packaged because the
 * renderer's document URL never moves: routes.tsx builds a `createMemoryRouter`
 * and nothing in the renderer touches window.history, so the document stays at
 * the renderer entry for the life of the window.
 *
 * `isDesktopShell()` probes the preload bridge, which is installed before any
 * renderer code runs — so it is already true on desktop's first render, and
 * false during both SSR and hydration on web. No flash, no hydration mismatch.
 *
 * It is imported from its own module rather than the `platform` barrel: this
 * file has no "use client", so on web it is evaluated in the React Server
 * Component graph, and the barrel re-exports hook modules that a server module
 * may not pull in. `help-launcher.tsx` and `plugin-panel-section.tsx` deep-
 * import it for the same reason.
 */

import { isDesktopShell } from "../../platform/local-directory";

/** Directory both platforms expose their copy of the prototypes under. */
export const GALLERY_ASSET_DIR = "gallery";

/**
 * Resolve a prototype's iframe `src` for the platform currently rendering.
 *
 * Exported separately from the component so the two-branch rule has one home
 * and can be asserted directly, rather than through a DOM mount.
 */
export function galleryAssetSrc(screenId: string, desktop = isDesktopShell()): string {
  const prefix = desktop ? `./${GALLERY_ASSET_DIR}/` : `/${GALLERY_ASSET_DIR}/`;
  return `${prefix}${screenId}.html`;
}
