import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CockpitSchema } from "@multica/core/api/schemas";
import { I18nProvider } from "@multica/core/i18n/react";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitOverview } from "./cockpit-overview";

function setup(readOnly = false) {
  const onPatchBoard = vi.fn();
  const goal = "Deliver the programme's annual outcomes with all modules in scope";
  const board = { cockpit: CockpitSchema.parse({ id: "board", title: "Programme", goal_title: goal }), nodes: [], payments: [], milestones: [] };
  render(<I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitOverview
    board={board} today="2026-10-14" readOnly={readOnly} ownerSuggestions={[]}
    contextNodeIds={new Set()} displayCodes={new Map()} meetingsSlot={null}
    onPatchBoard={onPatchBoard} onPatchNode={vi.fn()} onPatchMilestone={vi.fn()}
    onCreateMilestone={vi.fn()} onDeleteMilestone={vi.fn()} onOpenBranch={vi.fn()}
  /></I18nProvider>);
  return { onPatchBoard, goal };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date(2026, 9, 14, 23, 59, 20));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("annual objective paper surface", () => {
  it("keeps the goal editable and the local wall clock live through midnight", () => {
    const { onPatchBoard, goal } = setup();
    expect(screen.getByRole("button", { name: enCockpit.overview.annual_goal })).toHaveTextContent(goal);
    expect(screen.getByText("2026-10-14")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: enCockpit.overview.annual_goal }));
    const field = screen.getByRole("textbox", { name: enCockpit.overview.annual_goal });
    fireEvent.change(field, { target: { value: "Confirm the annual programme outcomes" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onPatchBoard).toHaveBeenCalledExactlyOnceWith({ goal_title: "Confirm the annual programme outcomes" });
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("2026-10-15")).toBeVisible();
  });

  it("keeps read-only annual goals visible without exposing an edit control", () => {
    const { goal, onPatchBoard } = setup(true);
    expect(screen.getByText(goal)).toBeVisible();
    expect(screen.queryByRole("button", { name: enCockpit.overview.annual_goal })).toBeNull();
    expect(screen.queryByRole("textbox", { name: enCockpit.overview.annual_goal })).toBeNull();
    expect(screen.getByText("2026-10-14")).toBeVisible();
    expect(onPatchBoard).not.toHaveBeenCalled();
  });
});
