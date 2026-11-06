/**
 * The showcase catalogue: what the workspace has delivered.
 *
 * This is committed content, not server state. Each entry points at a
 * self-contained prototype shipped under each platform's static root (see
 * `gallery-asset-src.ts` for why there are two copies), so the gallery has
 * nothing to fetch and works offline in both the web app and the desktop
 * shell.
 *
 * Names and summaries stay untranslated on purpose. They are the delivered
 * artefact's own identity — a product name and the customer-facing pitch that
 * came with it — the same way an agent's or a project's name is not run
 * through i18n. Only the surrounding chrome (buttons, labels, counts) lives in
 * `locales/*\/gallery.json`.
 */

/**
 * The sign-in a prototype accepts.
 *
 * Our copies of the prototypes ship with these already filled into the login
 * form, so a viewer only has to press the button. They are still surfaced in
 * the viewer, because the prototypes clear both fields on sign-out and a demo
 * you cannot get back into is a demo that ends at the first stray click.
 *
 * Per screen, not per work: the three gated prototypes validate differently.
 * Keep an entry in step with the `value=` attributes on that document's
 * `#loginAccount` / `#loginPassword` inputs.
 */
export interface PrototypeCredentials {
  account: string;
  password: string;
}

export interface GalleryScreen {
  /** Stable id; also the prototype's file stem under `/gallery/`. */
  id: string;
  name: string;
  summary: string;
  /** Absent when the prototype drops straight into its main view. */
  credentials?: PrototypeCredentials;
}

/**
 * A drawn plate that came with a work, shown in the carousel above the
 * catalogue.
 *
 * A diagram hangs off the work it documents rather than living in a list of
 * its own, so the carousel's running head is the same string as the card
 * below it and the two cannot drift.
 *
 * Every plate ships at `GALLERY_DIAGRAM_WIDTH` x `GALLERY_DIAGRAM_HEIGHT`, and
 * the frame's 16:9 box matches that exactly — so `object-contain` letterboxes
 * nothing today, and letterboxes rather than cropping the day one arrives
 * off-ratio.
 */
export interface GalleryDiagram {
  id: string;
  /** File name under each platform's static `gallery/` root, extension included. */
  file: string;
  /** The plate's own title, as lettered into the artwork. Also its `alt`. */
  title: string;
  /** The title's first clause — what a picker chip can fit. */
  shortTitle: string;
  /** The reading key: what the plate argues, not its title restated. */
  caption: string;
  /**
   * The plate in words, for a reader who cannot see it.
   *
   * Kept out of `alt` on purpose: a paragraph-long `alt` is its own
   * accessibility failure, so the short `title` identifies the image and this
   * hangs off it through `aria-describedby`.
   */
  description: string;
}

export interface GalleryWork {
  id: string;
  name: string;
  /** One-line positioning shown next to the title. */
  tagline: string;
  summary: string;
  /** Short capability chips rendered under the summary. */
  highlights: string[];
  screens: GalleryScreen[];
  /** Plates this work was delivered with. The page opens on the first work that has any. */
  diagrams?: GalleryDiagram[];
}

/** The size every hero plate is exported at. */
export const GALLERY_DIAGRAM_WIDTH = 1536;
export const GALLERY_DIAGRAM_HEIGHT = 864;

export const GALLERY_WORKS: GalleryWork[] = [
  // Deliberately empty in the generic distribution: the gallery framework
  // stays (page, carousel, viewer, types), while delivered-work entries are
  // per-deployment content. The fork's original showcase entries were
  // customer-specific (project names, summaries, prototypes) and were removed
  // from the tree; a deployment adds its own works here.
];
