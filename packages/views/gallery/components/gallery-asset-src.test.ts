// @vitest-environment node
import { describe, expect, it } from "vitest";
import { GALLERY_ASSET_DIR, galleryAssetSrc } from "./gallery-asset-src";
import { GALLERY_WORKS } from "./gallery-catalog";

// Canonical file for the two-platform src rule. The component suite mounts the
// page and asserts wiring; the matrix of "which prefix on which platform"
// lives here, where it needs no DOM.

describe("galleryAssetSrc", () => {
  it("uses a root-absolute path on web, where the document is /{slug}/gallery", () => {
    // A document-relative src would resolve against the page's own path and
    // land on /{slug}/gallery/gallery/<id>.html.
    expect(galleryAssetSrc("user-portal", false)).toBe("/gallery/user-portal.html");
  });

  it("uses a document-relative path on desktop, where the document is a file:// entry", () => {
    // A root-absolute src would resolve to file:///gallery/<id>.html, outside
    // the packaged renderer directory.
    expect(galleryAssetSrc("user-portal", true)).toBe("./gallery/user-portal.html");
  });

  it("resolves to the packaged renderer directory from the desktop entry document", () => {
    const entry = "file:///Applications/Multica.app/Contents/Resources/app.asar/out/renderer/index.html";
    expect(new URL(galleryAssetSrc("admin-console", true), entry).href).toBe(
      "file:///Applications/Multica.app/Contents/Resources/app.asar/out/renderer/gallery/admin-console.html",
    );
  });

  it("resolves to the site root from any web page depth", () => {
    expect(new URL(galleryAssetSrc("admin-console", false), "https://app.example.com/acme/gallery").href).toBe(
      "https://app.example.com/gallery/admin-console.html",
    );
  });

  it("keeps every catalogued screen inside the shared asset directory", () => {
    for (const work of GALLERY_WORKS) {
      for (const screen of work.screens) {
        expect(galleryAssetSrc(screen.id, false)).toBe(`/${GALLERY_ASSET_DIR}/${screen.id}.html`);
      }
    }
  });
});

describe("GALLERY_WORKS", () => {
  it("gives every work at least one screen, since the card covers with its lead", () => {
    for (const work of GALLERY_WORKS) {
      expect(work.screens.length).toBeGreaterThan(0);
    }
  });

  it("keeps screen ids unique, so the viewer's tab selection is unambiguous", () => {
    for (const work of GALLERY_WORKS) {
      const ids = work.screens.map((screen) => screen.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("keeps work ids unique", () => {
    const ids = GALLERY_WORKS.map((work) => work.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
