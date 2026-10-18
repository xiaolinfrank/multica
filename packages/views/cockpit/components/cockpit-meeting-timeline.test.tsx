import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { CockpitMeetingSchema } from "@multica/core/api/schemas";
import type { CockpitMeetingCard } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitMeetingTimeline } from "./cockpit-meeting-timeline";

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", () => ({ useReducedMotion: () => motion.reduced }));
const meeting: CockpitMeetingCard = {
  ...CockpitMeetingSchema.parse({ id: "meeting-1", title: "Delivery review", status: "", meet_date: "2026-10-14", track: "Delivery" }),
  issue_count: 0, node_count: 0, workflow_enabled: false, workflow_stage: "not_enabled", display_excerpt: "Review the release",
};
const scrollTo = vi.fn();
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
let frames: FrameRequestCallback[];
beforeEach(() => {
  motion.reduced = false; scrollTo.mockClear(); frames = [];
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(720);
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});
function show(selectedId: string | null = null) {
  const onSelect = vi.fn();
  const view = render(<I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>
    <CockpitMeetingTimeline meetings={[meeting]} today="2026-10-14" selectedId={selectedId} onSelect={onSelect} />
  </I18nProvider>);
  const viewport = view.container.querySelector<HTMLElement>("[data-cockpit-scroll]")!;
  return { ...view, viewport, onSelect };
}
function settleMount() {
  act(() => { const pending = frames; frames = []; pending.forEach((frame) => frame(0)); });
}

describe("CockpitMeetingTimeline motion preferences", () => {
  it("places the first frame at measured geometry without an entrance zoom", () => {
    show();
    const card = screen.getByRole("button", { name: "Open Delivery review" });
    expect(Number.parseFloat(card.style.left)).toBeGreaterThan(0);
    expect(card.style.transition).not.toContain("left");
  });

  it("updates zoom geometry immediately, disables inline transitions and preserves selection when motion is reduced", () => {
    motion.reduced = true;
    const { viewport, onSelect } = show("meeting-1");
    settleMount();
    const card = screen.getByRole("button", { name: "Open Delivery review" });
    expect(card).toHaveAttribute("aria-current", "true");
    expect(card.style.transition).toBe("none");
    fireEvent.click(screen.getByRole("button", { name: "Free scroll" }));
    const initialWidth = Number.parseFloat((viewport.firstElementChild as HTMLElement).style.width);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(Number.parseFloat((viewport.firstElementChild as HTMLElement).style.width)).toBeGreaterThan(initialWidth);
    for (const element of viewport.querySelectorAll<HTMLElement>('[style*="transition"]')) expect(element.style.transition).toBe("none");
    fireEvent.click(card);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("meeting-1");
    expect(card).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "auto" }));
  });

  it("keeps smooth toolbar scrolling for viewers without reduced motion", () => {
    show(); settleMount();
    fireEvent.click(screen.getByRole("button", { name: "Free scroll" }));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "smooth" }));
  });

  it("follows pinch geometry immediately even when ordinary zooms animate", () => {
    const { viewport } = show(); settleMount();
    fireEvent.wheel(viewport, { ctrlKey: true, deltaY: -200, clientX: 350 });
    const card = screen.getByRole("button", { name: "Open Delivery review" });
    expect(card.style.transition).not.toContain("left");
    expect(screen.getByRole("button", { name: "Free scroll" })).toHaveAttribute("aria-pressed", "true");
  });
});
