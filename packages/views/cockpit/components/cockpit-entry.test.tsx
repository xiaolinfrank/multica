import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({ params: new URLSearchParams(), wsId: "ws-1", push: vi.fn() }));
const board = vi.hoisted(() => vi.fn());
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => route.wsId }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/acme/cockpit", searchParams: route.params, push: route.push }) }));
vi.mock("./cockpit-work-overview", () => ({ CockpitWorkOverview: ({ wsId, today, onOpenArea }: {
  wsId: string; today: string; onOpenArea: (area: "gantt" | "operations") => void;
}) => <section aria-label="Work overview"><span>{wsId}</span><time>{today}</time>
  <button onClick={() => onOpenArea("operations")}>Business overview</button><button onClick={() => onOpenArea("gantt")}>Execution plan</button></section> }));
vi.mock("./cockpit-page", () => ({ CockpitBoardWorkspace: (props: { initialTab: string; today: string; onWorkOverview: () => void; onSelectTab: (tab: "meetings") => void }) => {
  board(props);
  return <section aria-label="Board workspace"><span>{props.initialTab}</span><time>{props.today}</time>
    <button onClick={props.onWorkOverview}>Work overview</button><button onClick={() => props.onSelectTab("meetings")}>Meetings</button></section>;
} }));

import { CockpitPage } from "./cockpit-entry";

beforeEach(() => { route.params = new URLSearchParams(); route.wsId = "ws-1"; route.push.mockReset(); board.mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("cockpit entry isolation", () => {
  it("does not mount the complete board just to display the work overview", () => {
    render(<CockpitPage />);
    expect(screen.getByRole("region", { name: "Work overview" })).toBeInTheDocument();
    expect(board).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Business overview" }));
    expect(route.push).toHaveBeenCalledWith("/acme/cockpit?view=operations");
    fireEvent.click(screen.getByRole("button", { name: "Execution plan" }));
    expect(route.push).toHaveBeenCalledWith("/acme/cockpit?tab=gantt");
  });

  it("keeps the existing business view reachable and removes stale targets on section navigation", () => {
    route.params = new URLSearchParams("view=operations");
    render(<CockpitPage />);
    expect(screen.getByRole("region", { name: "Board workspace" })).toHaveTextContent("overview");
    fireEvent.click(screen.getByRole("button", { name: "Meetings" }));
    expect(route.push).toHaveBeenCalledWith("/acme/cockpit?tab=meetings");
    fireEvent.click(screen.getByRole("button", { name: "Work overview" }));
    expect(route.push).toHaveBeenCalledWith("/acme/cockpit");
  });

  it("enters the correct existing workspace for meeting and L3 deep links", () => {
    route.params = new URLSearchParams("meeting=m1&action=a1");
    const { rerender } = render(<CockpitPage />);
    expect(board.mock.lastCall?.[0]).toMatchObject({ initialTab: "meetings" });
    route.params = new URLSearchParams("node=n1"); rerender(<CockpitPage />);
    expect(board.mock.lastCall?.[0]).toMatchObject({ initialTab: "gantt" });
    route.params = new URLSearchParams(); rerender(<CockpitPage />);
    expect(screen.queryByRole("region", { name: "Board workspace" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Work overview" })).toBeInTheDocument();
  });

  it("updates the explicit calendar scope across midnight in an open tab", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 10, 23, 59, 30));
    render(<CockpitPage />);
    expect(screen.getByText("2026-10-10")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText("2026-10-11")).toBeInTheDocument();
    expect(board).not.toHaveBeenCalled();
  });
});
