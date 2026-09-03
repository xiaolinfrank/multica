import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enGallery from "../../locales/en/gallery.json";
import { GALLERY_WORKS, type GalleryWork } from "./gallery-catalog";
import { GalleryHeroCarousel } from "./gallery-hero-carousel";

// The index matrix is pinned in gallery-hero-steps.test.ts (node suite). This
// file keeps the happy path, the wiring, the accessibility contract, and the
// named regressions.

// isDesktopShell() probes window.desktopAPI; jsdom has none, so the whole suite
// runs on the web branch — the branch the src assertions below expect.
vi.mock("../../platform/local-directory", () => ({ isDesktopShell: () => false }));

const work: GalleryWork = GALLERY_WORKS.find((entry) => (entry.diagrams?.length ?? 0) > 1)!;
const diagrams = work.diagrams!;

function renderCarousel() {
  return render(
    <I18nProvider locale="en" resources={{ en: { gallery: enGallery } }}>
      <GalleryHeroCarousel work={work} />
    </I18nProvider>,
  );
}

/**
 * The plate carrying `title` on the page.
 *
 * By alt text rather than by role: an inactive plate is `aria-hidden`, so it is
 * out of the accessibility tree and `getByRole("img")` cannot reach it — which
 * is exactly the state these tests need to assert. Scoped to the tab panel so
 * it never collides with the copy the dialog renders.
 */
function plate(title: string): HTMLElement {
  return within(screen.getByRole("tabpanel")).getByAltText(title);
}

describe("GalleryHeroCarousel", () => {
  it("mounts every plate, pointed at its own file under the shared asset root", () => {
    renderCarousel();

    // All of them stay mounted so paging back and forth never re-fetches: see
    // the component's note on comparing two diagrams.
    for (const diagram of diagrams) {
      expect(plate(diagram.title)).toHaveAttribute("src", `/gallery/${diagram.file}`);
    }
  });

  it("shows the first plate and hides the rest from assistive tech", () => {
    renderCarousel();

    expect(plate(diagrams[0]!.title)).not.toHaveAttribute("aria-hidden", "true");
    expect(plate(diagrams[1]!.title)).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText(diagrams[0]!.caption)).toBeInTheDocument();
  });

  it("names the work the plates were delivered with", () => {
    renderCarousel();

    // A <p>, not a heading: the work's own card renders the same string as its
    // <h2>, and two headings with one name would make the page outline lie.
    const running = screen.getByText(work.name);
    expect(running.tagName).toBe("P");
  });

  it("pages to the next plate when the picker chip is chosen", () => {
    renderCarousel();

    const target = diagrams[1]!;
    fireEvent.click(screen.getByRole("tab", { name: target.shortTitle }));

    expect(screen.getByRole("tab", { name: target.shortTitle })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(plate(target.title)).not.toHaveAttribute("aria-hidden", "true");
    expect(plate(diagrams[0]!.title)).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText(target.caption)).toBeInTheDocument();
  });

  it("pages with the arrow controls", () => {
    renderCarousel();

    fireEvent.click(screen.getByRole("button", { name: enGallery.hero.next }));

    expect(plate(diagrams[1]!.title)).not.toHaveAttribute("aria-hidden", "true");
  });

  // Boundaries stop, they do not wrap — the rule the editor's image sequence
  // states. The button stays mounted so nothing to its right shifts.
  it("marks the arrow that would leave the set unavailable, at both ends", () => {
    renderCarousel();

    const prev = () => screen.getByRole("button", { name: enGallery.hero.previous });
    const next = () => screen.getByRole("button", { name: enGallery.hero.next });

    expect(prev()).toHaveAttribute("aria-disabled", "true");
    expect(next()).not.toHaveAttribute("aria-disabled");

    fireEvent.click(screen.getByRole("tab", { name: diagrams[diagrams.length - 1]!.shortTitle }));

    expect(next()).toHaveAttribute("aria-disabled", "true");
    expect(prev()).not.toHaveAttribute("aria-disabled");
  });

  // Regression: with the real `disabled` attribute the browser blurs the button
  // the instant it goes unavailable, dropping the reader out of the carousel
  // onto <body>. aria-disabled keeps it focusable and inert.
  it("keeps the exhausted arrow focusable so keyboard focus is not dropped", () => {
    renderCarousel();

    const next = screen.getByRole("button", { name: enGallery.hero.next });
    next.focus();
    for (let step = 1; step < diagrams.length; step += 1) fireEvent.click(next);

    expect(next).toHaveAttribute("aria-disabled", "true");
    expect(document.activeElement).toBe(next);
  });

  it("pages on the arrow keys and swallows them even at a boundary", () => {
    renderCarousel();
    const region = screen.getByRole("region");

    fireEvent.keyDown(region, { key: "ArrowRight" });
    expect(plate(diagrams[1]!.title)).not.toHaveAttribute("aria-hidden", "true");

    fireEvent.keyDown(region, { key: "End" });
    expect(plate(diagrams[diagrams.length - 1]!.title)).not.toHaveAttribute("aria-hidden", "true");

    // A blocked key must still be claimed, or the page scrolls sideways under a
    // reader who thought they were paging.
    const blocked = fireEvent.keyDown(region, { key: "ArrowRight" });
    expect(blocked).toBe(false);
  });

  it("leaves keys it does not own to the page", () => {
    renderCarousel();

    expect(fireEvent.keyDown(screen.getByRole("region"), { key: "ArrowDown" })).toBe(true);
  });

  it("re-announces the plate by name on every page, and the counter does not repeat it", () => {
    const { container } = renderCarousel();
    const live = () => container.querySelector("[aria-live='polite']");

    expect(live()).toHaveTextContent(`Diagram 1 of ${diagrams.length}: ${diagrams[0]!.title}`);
    expect(screen.getByText(`1 / ${diagrams.length}`)).toHaveAttribute("aria-hidden", "true");

    // A polite region announces on content CHANGE, so asserting it only at mount
    // would pass against a frozen string that no screen-reader user ever hears
    // change.
    fireEvent.click(screen.getByRole("button", { name: enGallery.hero.next }));
    expect(live()).toHaveTextContent(`Diagram 2 of ${diagrams.length}: ${diagrams[1]!.title}`);
  });

  // Opening the dialog puts aria-hidden on everything outside it, so the
  // description hanging off the on-page plate goes unreachable exactly when the
  // reader asked to look closer. The live region is NOT duplicated — Base UI
  // carves [aria-live] out of that sweep, and a second one would say it twice.
  it("keeps the long description reachable inside the dialog, without a second live region", () => {
    const { container } = renderCarousel();
    fireEvent.click(
      screen.getByRole("button", { name: `View ${diagrams[0]!.title} full size` }),
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("[aria-live]")).toBeNull();
    expect(container.querySelectorAll("[aria-live='polite']")).toHaveLength(1);

    const zoomed = within(dialog).getByRole("img", { name: diagrams[0]!.title });
    const describedBy = zoomed.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(dialog.querySelector(`#${CSS.escape(describedBy!)}`)).toHaveTextContent(
      diagrams[0]!.description,
    );
  });

  // Regression: the tablist half of the APG tabs pattern. An arrow pressed on a
  // chip must carry focus to the newly selected chip; the same arrow pressed
  // anywhere else must leave focus where the reader put it.
  it("carries focus with the selection only when the key came from the picker", () => {
    renderCarousel();

    const chip = (i: number) => screen.getByRole("tab", { name: diagrams[i]!.shortTitle });
    chip(0).focus();
    fireEvent.keyDown(chip(0), { key: "ArrowRight" });
    expect(document.activeElement).toBe(chip(1));
    expect(chip(1)).toHaveAttribute("tabindex", "0");
    expect(chip(0)).toHaveAttribute("tabindex", "-1");

    const enlarge = screen.getByRole("button", { name: enGallery.hero.enlarge });
    enlarge.focus();
    fireEvent.keyDown(enlarge, { key: "ArrowRight" });
    expect(plate(diagrams[2]!.title)).not.toHaveAttribute("aria-hidden", "true");
    expect(document.activeElement).toBe(enlarge);
  });

  // Modified arrows belong to the browser and the OS: Ctrl+End goes to the end
  // of the page, Cmd+Left goes back.
  it("leaves modified navigation keys to the browser", () => {
    renderCarousel();
    const region = screen.getByRole("region");

    expect(fireEvent.keyDown(region, { key: "End", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(region, { key: "ArrowLeft", metaKey: true })).toBe(true);
    expect(plate(diagrams[0]!.title)).not.toHaveAttribute("aria-hidden", "true");
  });

  // Regression: a cached plate can finish decoding before React commits onLoad,
  // and without the mount re-check the stage would stay blank on a second visit.
  it("reveals the stage for a plate that was already complete at mount", () => {
    // jsdom never loads images, so `complete` is the only signal available —
    // which is exactly the production race this guards.
    const complete = vi
      .spyOn(window.HTMLImageElement.prototype, "complete", "get")
      .mockReturnValue(true);
    try {
      renderCarousel();
      expect(plate(diagrams[0]!.title)).toHaveClass("opacity-100");
    } finally {
      complete.mockRestore();
    }
  });

  it("reveals a plate that fails to load, rather than leaving the stage blank", () => {
    renderCarousel();
    expect(plate(diagrams[0]!.title)).toHaveClass("opacity-0");

    fireEvent.error(plate(diagrams[0]!.title));

    expect(plate(diagrams[0]!.title)).toHaveClass("opacity-100");
  });

  // Regression: readiness used to be one flag set by the first plate only, so
  // paging early on a slow link showed an empty well — and the first plate is
  // in fact the largest of the three files, so it is the one most likely to
  // finish last.
  it("shows a plate as soon as its own bytes resolve, not when the first one does", () => {
    renderCarousel();

    const late = diagrams[1]!;
    fireEvent.load(plate(late.title));
    fireEvent.click(screen.getByRole("tab", { name: late.shortTitle }));

    expect(plate(late.title)).toHaveClass("opacity-100");
    expect(plate(diagrams[0]!.title)).toHaveClass("opacity-0");
  });

  it("hangs the long description off the plate rather than stuffing it into alt", () => {
    renderCarousel();

    const frame = screen.getByRole("button", {
      name: `View ${diagrams[0]!.title} full size`,
    });
    const describedBy = frame.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent(diagrams[0]!.description);
    // alt stays short and identifying; a paragraph-long alt is its own failure.
    expect(plate(diagrams[0]!.title)).toHaveAttribute("alt", diagrams[0]!.title);
  });

  it("opens the plate at full size, and the dialog pages with the carousel", () => {
    renderCarousel();

    fireEvent.click(
      screen.getByRole("button", { name: `View ${diagrams[0]!.title} full size` }),
    );

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(diagrams[0]!.title)).toBeInTheDocument();
    expect(within(dialog).getByRole("img", { name: diagrams[0]!.title })).toHaveAttribute(
      "src",
      `/gallery/${diagrams[0]!.file}`,
    );

    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(within(dialog).getByRole("img", { name: diagrams[1]!.title })).toHaveAttribute(
      "src",
      `/gallery/${diagrams[1]!.file}`,
    );
  });

  it("renders nothing for a work with no plates", () => {
    const { container } = render(
      <I18nProvider locale="en" resources={{ en: { gallery: enGallery } }}>
        <GalleryHeroCarousel work={{ ...work, diagrams: [] }} />
      </I18nProvider>,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
