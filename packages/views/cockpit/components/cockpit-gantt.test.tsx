import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { computeCockpitAxis, daysBetween, parseDay } from "@multica/core/cockpit";
import type { CockpitNode, CockpitPlanMeetingMarkerQuery } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitGantt, type CockpitGanttProps } from "./cockpit-gantt";

const mocks = vi.hoisted(() => ({ reduced: false, queries: vi.fn((_options: { queries: Array<{ queryKey: unknown[] }> }) => []) }));
vi.mock("motion/react", () => ({ useReducedMotion: () => mocks.reduced }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams() }) }));
vi.mock("./use-cockpit-scroll-memory", () => ({ useCockpitScrollMemory: () => {} }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQueries: mocks.queries,
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, start: 36 + index * 32 })),
    scrollToIndex: vi.fn(),
  }),
}));

function node(id: string, overrides: Partial<CockpitNode>): CockpitNode {
  return { id, cockpit_id: "cp", parent_id: null, code: id, name: id, position: 0,
    color: "", owner: "Li", collaborators: "", start_date: "2026-06-01", end_date: "2026-12-31",
    status: "In progress", progress: 40, deliverable: "", dependencies: "", note: "",
    current_progress: "", vendor: "", budget_category: "", budget_amount: 1.000001,
    exec_status: "", contract: "", source: "", updated_by_type: "", updated_by_id: null,
    created_at: "", updated_at: "", ...overrides };
}
const nodes = [
  node("root", { code: "L1-03", name: "Programme" }),
  node("branch", { code: "03.09", parent_id: "root", name: "Direction" }),
  node("leaf", { code: "historic-task", parent_id: "branch", name: "Execution task", collaborators: "Partner" }),
];
const board: CockpitGanttProps["board"] = {
  cockpit: { id: "cp", workspace_id: "ws-1", title: "Board", goal_title: "", goal_date: null,
    summary_overall: "", summary_next: "", summary_support: "", basis: "", meeting_assignee_type: "",
    meeting_assignee_id: null, meeting_project_id: null, meeting_module_id: null, meeting_node_id: null,
    meeting_dir: "", created_at: "", updated_at: "" }, nodes, payments: [],
};
let width = 320;
let frames: Map<number, FrameRequestCallback>;
let observers: Array<() => void>;
const scrollTo = vi.fn();
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
beforeEach(() => {
  width = 320; mocks.reduced = false; mocks.queries.mockClear(); scrollTo.mockClear();
  frames = new Map(); observers = [];
  let frameId = 0;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { observers.push(callback); }
    observe() {} disconnect() {}
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});
function flushFrames() {
  act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach((frame) => frame(0)); });
}
function resize(nextWidth: number) {
  width = nextWidth;
  act(() => observers.forEach((read) => read()));
  flushFrames();
}
function show(overrides: Partial<CockpitGanttProps> = {}) {
  const props: CockpitGanttProps = { board, displayCodes: new Map([["root", "03"], ["branch", "03.01"], ["leaf", "03.01.01"]]),
    contextNodeIds: new Set(), taskCounts: new Map(), today: "2026-10-14", zoom: "month", query: "", rootIds: new Set(), collapsed: new Set(),
    onToggleCollapse: vi.fn(), onSelect: vi.fn(), selectedId: null, onPatchNode: vi.fn(), statusSuggestions: [], ownerSuggestions: [],
    showFinance: true, toolbarOpen: false, scrollToTodayNonce: 0, focusTarget: null, ...overrides };
  const ui = (next: CockpitGanttProps) => <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitGantt {...next} /></I18nProvider>;
  const view = render(ui(props));
  const viewport = view.container.querySelector<HTMLElement>("[data-cockpit-scroll]")!;
  const tree = viewport.firstElementChild!.firstElementChild as HTMLElement;
  return { ...view, props, viewport, tree, update: (next: Partial<CockpitGanttProps>) => view.rerender(ui({ ...props, ...next })) };
}

describe("CockpitGantt responsive identity", () => {
  it("reserves half a 320px container for dates while retaining open, edit and collapse actions", () => {
    const { tree, props } = show();
    expect(tree.style.width).toBe("160px");
    expect(within(tree).queryByRole("button", { name: "Owner" })).toBeNull();
    expect(within(tree).queryByText("Partner")).toBeNull();
    fireEvent.click(within(tree).getByRole("button", { name: "Open 03.01.01" }));
    expect(props.onSelect).toHaveBeenCalledWith("leaf");
    fireEvent.click(within(tree).getByRole("button", { name: /Collapse.*Direction/ }));
    expect(props.onToggleCollapse).toHaveBeenCalledWith("branch");
    const leaf = tree.querySelector<HTMLElement>('[data-cockpit-node="leaf"]')!;
    fireEvent.click(within(leaf).getByRole("button", { name: "Name" }));
    const editor = within(leaf).getByRole("textbox", { name: "Name" });
    fireEvent.change(editor, { target: { value: "Renamed task" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(props.onPatchNode).toHaveBeenCalledWith("leaf", { name: "Renamed task" });
  });

  it("measures the container rather than the browser and restores metadata after export", () => {
    const { tree, update } = show();
    update({ renderAllRows: true });
    expect(tree.style.width).toBe("800px");
    expect(within(tree).getAllByRole("button", { name: "Owner" })).toHaveLength(3);
    expect(within(tree.querySelector<HTMLElement>('[data-cockpit-node="leaf"]')!).getByText("1.000001万")).toBeInTheDocument();
    update({ renderAllRows: false });
    expect(tree.style.width).toBe("160px");
    expect(within(tree).queryByRole("button", { name: "Owner" })).toBeNull();
    resize(1440);
    expect(tree.style.width).toBe("800px");
    update({ showFinance: false });
    expect(tree.style.width).toBe("680px");
    resize(320);
    expect(tree.style.width).toBe("160px");
  });

  it("does not recenter a previously located viewport during export or responsive resizing", () => {
    const { update, viewport } = show();
    update({ scrollToTodayNonce: 1 });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    viewport.scrollLeft = 240;
    update({ scrollToTodayNonce: 1, renderAllRows: true });
    update({ scrollToTodayNonce: 1, renderAllRows: false });
    resize(1440);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(viewport.scrollLeft).toBe(240);
  });

  it("reanchors today after changing scale without consuming the export resize", () => {
    mocks.reduced = true;
    const { update } = show();
    update({ scrollToTodayNonce: 1 });
    update({ scrollToTodayNonce: 1, zoom: "week" });
    const axis = computeCockpitAxis(nodes, "2026-10-14", { zoom: "week", goalDate: null });
    const todayOffset = daysBetween(axis.start, parseDay("2026-10-14")!) * 9;
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: todayOffset - 80, behavior: "auto" });
    update({ scrollToTodayNonce: 1, zoom: "week", renderAllRows: true });
    update({ scrollToTodayNonce: 1, zoom: "week", renderAllRows: false });
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it("sizes the meeting read window from the same compact tree geometry", () => {
    show({ onOpenMeeting: vi.fn() });
    const options = mocks.queries.mock.calls.at(-1)?.[0] as unknown as { queries: Array<{ queryKey: unknown[] }> };
    const params = options.queries[0]!.queryKey.at(-1) as CockpitPlanMeetingMarkerQuery;
    const span = daysBetween(parseDay(params.date_from)!, parseDay(params.date_to)!);
    expect(span).toBe(Math.ceil((320 - 160) / 3.5));
  });

  it.each([false, true])("centres today in the date area with reduced motion=%s", (reduced) => {
    mocks.reduced = reduced;
    const { update } = show();
    update({ scrollToTodayNonce: 1 });
    const axis = computeCockpitAxis(nodes, "2026-10-14", { zoom: "month", goalDate: null });
    const todayOffset = daysBetween(axis.start, parseDay("2026-10-14")!) * 3.5;
    expect(scrollTo).toHaveBeenLastCalledWith({ left: todayOffset - 80, behavior: reduced ? "auto" : "smooth" });
  });
});
