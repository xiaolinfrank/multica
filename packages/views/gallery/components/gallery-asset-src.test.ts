// @vitest-environment node
import { describe, expect, it } from "vitest";
import { GALLERY_ASSET_DIR, galleryAssetSrc, galleryAssetUrl } from "./gallery-asset-src";
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

describe("galleryAssetUrl", () => {
  it("takes the file name whole, so a plate needs no extension appended", () => {
    expect(galleryAssetUrl("architecture-integration.jpg", false)).toBe(
      "/gallery/architecture-integration.jpg",
    );
    expect(galleryAssetUrl("architecture-integration.jpg", true)).toBe(
      "./gallery/architecture-integration.jpg",
    );
  });

  it("keeps every catalogued diagram in the shared directory itself, not under or beside it", () => {
    // Asserting the returned URL against a template built from the same
    // `diagram.file` would restate the function body and pass for any input,
    // including "../secrets/x.jpg". Resolve it instead and check where it lands.
    for (const work of GALLERY_WORKS) {
      for (const diagram of work.diagrams ?? []) {
        const resolved = new URL(
          galleryAssetUrl(diagram.file, false),
          "https://app.example.com/acme/gallery",
        );
        expect(resolved.pathname).toBe(`/${GALLERY_ASSET_DIR}/${diagram.file}`);
        expect(diagram.file).not.toContain("/");
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

  it("gives each gated screen the sign-in its own prototype validates", () => {
    // Regression: the three gated prototypes were briefly catalogued with one
    // shared pair, which the admin console rejects outright — it validates
    // against its own user list, where "admin" does not exist.
    const gated = GALLERY_WORKS.flatMap((work) =>
      work.screens.filter((screen) => screen.credentials),
    );
    expect(gated.length).toBeGreaterThan(0);
    for (const screen of gated) {
      expect(screen.credentials?.account).toBeTruthy();
      expect(screen.credentials?.password).toBeTruthy();
    }
    expect(new Set(gated.map((screen) => screen.credentials!.account)).size).toBeGreaterThan(1);
  });

  it("keeps work ids unique", () => {
    const ids = GALLERY_WORKS.map((work) => work.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps screen names and taglines unique across the catalogue", () => {
    // The page renders one entry point per screen and one tagline per work, and
    // the page suite looks both up by their text. Two works sharing either
    // string would make those queries ambiguous rather than wrong, which is a
    // failure that reads as unrelated.
    const screenNames = GALLERY_WORKS.flatMap((work) =>
      work.screens.map((screen) => screen.name),
    );
    expect(new Set(screenNames).size).toBe(screenNames.length);

    const taglines = GALLERY_WORKS.map((work) => work.tagline);
    expect(new Set(taglines).size).toBe(taglines.length);
  });

  it("gives at least one work the plates the page opens on", () => {
    const plated = GALLERY_WORKS.filter((work) => (work.diagrams?.length ?? 0) > 0);
    expect(plated.length).toBeGreaterThan(0);

    for (const work of plated) {
      const ids = work.diagrams!.map((diagram) => diagram.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const diagram of work.diagrams!) {
        // The file name carries its own extension: galleryAssetUrl appends none.
        expect(diagram.file).toMatch(/\.(jpg|png|webp|svg)$/);
        expect(diagram.shortTitle.length).toBeGreaterThan(0);
        // The long description is what a reader who cannot see the plate gets
        // instead of it, so it has to say more than the caption does.
        expect(diagram.description.length).toBeGreaterThan(diagram.caption.length);
      }
    }
  });
});
