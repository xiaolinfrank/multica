import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enGallery from "../../locales/en/gallery.json";
import { GALLERY_WORKS } from "./gallery-catalog";
import { GalleryPage } from "./gallery-page";

// The src-per-platform matrix is pinned in gallery-asset-src.test.ts (node
// suite). This file keeps the happy path and the wiring: the catalogue renders,
// a screen opens the viewer on the screen that was clicked, the frame is
// pointed at that screen's document, and that screen's own sign-in is shown.

// isDesktopShell() probes window.desktopAPI; jsdom has none, so the whole
// suite runs on the web branch. That is the branch the assertions below expect.
vi.mock("../../platform/local-directory", () => ({ isDesktopShell: () => false }));

function renderPage() {
  return render(
    <I18nProvider locale="en" resources={{ en: { gallery: enGallery } }}>
      <GalleryPage />
    </I18nProvider>,
  );
}

// The work the switching assertions below drive, found by shape rather than by
// index: they need more than two screens and two screens whose sign-ins
// actually differ, and catalogue order is editorial — reordering it must not
// fail this file with an "undefined" that reads as an unrelated bug.
const work = GALLERY_WORKS.find((entry) => {
  if (entry.screens.length <= 2) return false;
  const accounts = entry.screens
    .filter((item) => item.credentials)
    .map((item) => item.credentials!.account);
  return new Set(accounts).size > 1;
})!;

describe("GalleryPage", () => {
  it("renders the page chrome with the catalogue count", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: enGallery.page.title })).toBeInTheDocument();
    expect(screen.getByText(String(GALLERY_WORKS.length))).toBeInTheDocument();
  });

  it("renders every catalogued work with its tagline and screen entry points", () => {
    renderPage();

    for (const entry of GALLERY_WORKS) {
      expect(screen.getByRole("heading", { name: entry.name })).toBeInTheDocument();
      expect(screen.getByText(entry.tagline)).toBeInTheDocument();
      for (const item of entry.screens) {
        expect(screen.getByRole("button", { name: item.name })).toBeInTheDocument();
      }
    }
  });

  it("shows the opened screen's own sign-in, not one pair standing in for all of them", () => {
    // The gated prototypes validate differently — the admin console rejects the
    // portal's account outright — so the viewer has to follow the active screen.
    // That the catalogue actually holds distinct pairs is asserted in
    // gallery-asset-src.test.ts; this covers the viewer following the switch.
    const gated = work.screens.filter((item) => item.credentials);
    const odd = gated.find((item) => item.credentials!.account !== gated[0]!.credentials!.account)!;
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: odd.name }));

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(
        `Signed in as ${odd.credentials!.account} / ${odd.credentials!.password}`,
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByText(new RegExp(gated[0]!.credentials!.account)),
    ).not.toBeInTheDocument();
  });

  it("opens the viewer on the screen that was clicked and frames that document", () => {
    renderPage();

    const target = work.screens[2]!;
    fireEvent.click(screen.getByRole("button", { name: target.name }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(`${work.name} · ${target.name}`)).toBeInTheDocument();

    const frame = within(dialog).getByTitle(`${work.name} · ${target.name}`);
    expect(frame).toHaveAttribute("src", `/gallery/${target.id}.html`);
    // First-party, storage-using documents: the origin must stay real or the
    // prototypes throw on sign-in. See prototype-frame.tsx.
    expect(frame.getAttribute("sandbox")).toContain("allow-same-origin");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
  });

  it("switches the framed document when another screen tab is selected", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: work.screens[0]!.name }));
    const dialog = screen.getByRole("dialog");

    const other = work.screens[1]!;
    fireEvent.click(within(dialog).getByRole("tab", { name: other.name }));

    const frame = within(dialog).getByTitle(`${work.name} · ${other.name}`);
    expect(frame).toHaveAttribute("src", `/gallery/${other.id}.html`);
    expect(within(dialog).getByRole("tab", { name: other.name })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("closes the viewer without leaving the page", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: work.screens[0]!.name }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: enGallery.page.title })).toBeInTheDocument();
  });
});
