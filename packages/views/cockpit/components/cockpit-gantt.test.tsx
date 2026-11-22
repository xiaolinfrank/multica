import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { computeCockpitAxis, daysBetween, parseDay } from "@multica/core/cockpit";
import type { CockpitNode, CockpitPlanMeetingMarkerQuery } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
import enProjects from "../../locales/en/projects.json";
import { CockpitGantt, type CockpitGanttProps } from "./cockpit-gantt";

const mocks = vi.hoisted(() => ({
  reduced: false,
  queries: vi.fn((_options: { queries: Array<{ queryKey: unknown[] }> }) => []),
  updateModule: vi.fn(async (id: string, data: { title: string }) => ({ id, title: data.title })),
  createCockpitWorkItem: vi.fn(async (body: { module_id: string; name: string }) => ({
    id: "w-new", cockpit_id: "cp", parent_id: "branch", code: "03.09.01", name: body.name,
    kind: "work_item", position: 9, color: "", owner: "", collaborators: "", start_date: null,
    end_date: null, status: "", progress: 0, deliverable: "", dependencies: "", note: "",
    current_progress: "", vendor: "", budget_category: "", budget_amount: null, exec_status: "",
    contract: "", source: "", updated_by_type: "", updated_by_id: null, created_at: "", updated_at: "",
  })),
  deleteCockpitNode: vi.fn(async () => {}),
  deleteModule: vi.fn(async () => {}),
  getContainerOperationBasis: vi.fn(async (wsId: string, kind: string, id: string): Promise<Record<string, unknown>> => ({
    workspace_id: wsId, schema_version: 1, generated_at: "2026-11-22T00:00:00Z", resource_kind: kind,
    resource_id: id, availability: "available", resource_revision: 1,
    delete: { state: "allowed", reason_codes: [] }, structural_edit: { state: "allowed", reason_codes: [] },
    add_child: { state: "allowed", reason_codes: [] }, targets: [], targets_total: 0,
  })),
  moveCockpitWorkItem: vi.fn(async (id: string, patch: { parent_id: string }) => ({ id, parent_id: patch.parent_id })),
}));
vi.mock("@multica/core/api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@multica/core/api");
  return { ...actual, api: {
    updateModule: mocks.updateModule,
    createCockpitWorkItem: mocks.createCockpitWorkItem,
    deleteCockpitNode: mocks.deleteCockpitNode,
    deleteModule: mocks.deleteModule,
    getContainerOperationBasis: mocks.getContainerOperationBasis,
    moveCockpitWorkItem: mocks.moveCockpitWorkItem,
  }, setApiInstance: () => {} };
});
vi.mock("motion/react", () => ({ useReducedMotion: () => mocks.reduced }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("../../navigation", () => ({
  useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams() }),
  AppLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@multica/core/paths", async (importOriginal) => ({
  ...await importOriginal<typeof import("@multica/core/paths")>(),
  useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}`, projectDetail: (id: string) => `/ws/projects/${id}` }),
}));
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
  node("branch", { code: "03.09", parent_id: "root", name: "Direction", kind: "module", module_id: "mod-branch" }),
  node("leaf", { code: "historic-task", parent_id: "branch", name: "Execution task", collaborators: "Partner" }),
];
const board: CockpitGanttProps["board"] = {
  cockpit: { id: "cp", workspace_id: "ws-1", title: "Board", goal_title: "", goal_date: null,
    summary_overall: "", summary_next: "", summary_support: "", basis: "", meeting_assignee_type: "",
    meeting_assignee_id: null, meeting_project_id: null, meeting_module_id: null, meeting_node_id: null,
    meeting_dir: "", created_at: "", updated_at: "", plan_reconciled_at: "2026-11-20T00:00:00Z" }, nodes, payments: [],
};
let width = 320;
let frames: Map<number, FrameRequestCallback>;
let observers: Array<() => void>;
const scrollTo = vi.fn();
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
beforeEach(() => {
  width = 320; mocks.reduced = false; mocks.queries.mockClear(); scrollTo.mockClear();
  mocks.deleteModule.mockClear(); mocks.getContainerOperationBasis.mockClear();
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
  const props: CockpitGanttProps = { board,
    contextNodeIds: new Set(), taskCounts: new Map(), today: "2026-10-14", zoom: "month", query: "", rootIds: new Set(), collapsed: new Set(),
    onToggleCollapse: vi.fn(), onSelect: vi.fn(), selectedId: null, onPatchNode: vi.fn(), statusSuggestions: [], ownerSuggestions: [],
    showFinance: true, toolbarOpen: false, scrollToTodayNonce: 0, focusTarget: null, ...overrides };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (next: CockpitGanttProps) => <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, projects: enProjects } }}>
    <QueryClientProvider client={qc}><CockpitGantt {...next} /></QueryClientProvider>
  </I18nProvider>;
  const view = render(ui(props));
  const viewport = view.container.querySelector<HTMLElement>("[data-cockpit-scroll]")!;
  const tree = viewport.firstElementChild!.firstElementChild as HTMLElement;
  return { ...view, props, viewport, tree, update: (next: Partial<CockpitGanttProps>) => view.rerender(ui({ ...props, ...next })) };
}

describe("CockpitGantt responsive identity", () => {
  it("reserves half a 320px container for dates while retaining open, edit and collapse actions", async () => {
    const { tree, props } = show();
    expect(tree.style.width).toBe("160px");
    expect(within(tree).queryByRole("button", { name: "Owner" })).toBeNull();
    expect(within(tree).queryByText("Partner")).toBeNull();
    fireEvent.click(within(tree).getByRole("button", { name: "Open historic-task" }));
    expect(props.onSelect).toHaveBeenCalledWith("leaf");
    const branch = tree.querySelector<HTMLElement>('[data-cockpit-node="branch"]')!;
    fireEvent.click(within(branch).getByRole("button", { name: "Collapse" }));
    expect(props.onToggleCollapse).toHaveBeenCalledWith("branch");
    // A module row's title is the module record (I5), so the rename goes to
    // updateModule — writing the node's name would change nothing on screen.
    fireEvent.doubleClick(within(branch).getByRole("button", { name: "Direction" }));
    let editor = within(branch).getByRole("textbox");
    fireEvent.change(editor, { target: { value: "Renamed direction" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(mocks.updateModule).toHaveBeenCalledWith("mod-branch", { title: "Renamed direction" }));
    expect(props.onPatchNode).not.toHaveBeenCalledWith("branch", expect.objectContaining({ name: expect.anything() }));

    // A refused rename keeps the editor open with the typed draft, the same
    // rule as the plan tree — closing it would throw the text away.
    mocks.updateModule.mockRejectedValueOnce(new Error("module rename refused"));
    // The mock never refreshes the board, so the row still reads the old
    // title; find it by what is on screen rather than what was submitted.
    fireEvent.doubleClick(within(branch).getByRole("button", { name: "Direction" }));
    editor = within(branch).getByRole("textbox");
    fireEvent.change(editor, { target: { value: "Second attempt" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("module rename refused"));
    await waitFor(() => expect(within(branch).getByRole("textbox")).toHaveValue("Second attempt"));
  });

  it("offers the tree's row actions in the name column", async () => {
    const { tree } = show({ renderAllRows: true });
    const branch = tree.querySelector<HTMLElement>('[data-cockpit-node="branch"]')!;
    // "+" on a module creates a work item inline, with the same creation key
    // rule as the tree: a retry replays the row instead of duplicating it.
    fireEvent.click(within(branch).getByRole("button", { name: enCockpit.plan_tree.add_child }));
    const field = within(branch).getByRole("textbox");
    fireEvent.change(field, { target: { value: "New work item" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(mocks.createCockpitWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({ module_id: "mod-branch", name: "New work item", creation_key: expect.any(String) }),
      "ws-1",
    ));

    // "…" on a work item offers move and delete; delete confirms first.
    const leaf = tree.querySelector<HTMLElement>('[data-cockpit-node="leaf"]')!;
    fireEvent.click(within(leaf).getByRole("button", { name: enCockpit.plan_tree.more }));
    expect(screen.getByRole("menuitem", { name: enCockpit.plan_tree.move })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: enCockpit.plan_tree.delete }));
    expect(mocks.deleteCockpitNode).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: enCockpit.plan_tree.confirm }));
    await waitFor(() => expect(mocks.deleteCockpitNode).toHaveBeenCalledWith("leaf"));
  });

  it("reports a work item's issue ratio instead of a typed progress field", () => {
    const withSecondItem = {
      ...board,
      nodes: [...nodes, node("leaf2", { code: "historic-task-2", parent_id: "branch", name: "Second task" })],
    };
    const taskCounts = new Map([["leaf", { node_id: "leaf", primary_total: 4, reference_total: 0, active: 1, done: 3, closed: 0 }]]);
    const { tree } = show({ board: withSecondItem, renderAllRows: true, taskCounts });
    const leaf = tree.querySelector<HTMLElement>('[data-cockpit-node="leaf"]')!;
    expect(within(leaf).getByText("75%")).toBeInTheDocument();
    // No typed field: the ratio follows the issues, here and in the panel.
    expect(within(leaf).queryByRole("button", { name: "Progress" })).toBeNull();
    // A work item with no issues keeps the typed editor.
    const leaf2 = tree.querySelector<HTMLElement>('[data-cockpit-node="leaf2"]')!;
    expect(within(leaf2).getByRole("button", { name: "Progress" })).toBeInTheDocument();
  });

  it("deletes a module through the tree's own confirmation, counts included", async () => {
    const boardWithPayment = {
      ...board,
      payments: [{ id: "p1", node_id: "leaf", label: "First", pay_date: null, amount: 10, position: 0 }],
    };
    const taskCounts = new Map([["branch", { node_id: "branch", primary_total: 2, reference_total: 0, active: 1, done: 1, closed: 0 }]]);
    const { tree } = show({ board: boardWithPayment, renderAllRows: true, taskCounts });
    const branch = tree.querySelector<HTMLElement>('[data-cockpit-node="branch"]')!;
    fireEvent.click(within(branch).getByRole("button", { name: enCockpit.plan_tree.more }));
    fireEvent.click(screen.getByRole("menuitem", { name: enCockpit.plan_tree.delete }));
    const dialog = await screen.findByRole("alertdialog");
    // One work item, one payment, two rolled-up issues: the same figures the
    // plan tree's dialog shows.
    expect(dialog).toHaveTextContent("Deletes 1 work items and 1 payments; 2 issues lose their filing and stay in the project.");
    const confirm = within(dialog).getByRole("button", { name: "Delete module" });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.deleteModule).toHaveBeenCalledWith("ws-1", "mod-branch"));
  });

  it("refuses the module delete when the operation basis does", async () => {
    mocks.getContainerOperationBasis.mockResolvedValueOnce({
      workspace_id: "ws-1", schema_version: 1, generated_at: "2026-11-22T00:00:00Z", resource_kind: "module",
      resource_id: "mod-branch", availability: "available", resource_revision: 1,
      delete: { state: "blocked", reason_codes: ["has_issue_ownership"] }, structural_edit: { state: "allowed", reason_codes: [] },
      add_child: { state: "allowed", reason_codes: [] }, targets: [], targets_total: 0,
    });
    const { tree } = show({ renderAllRows: true });
    const branch = tree.querySelector<HTMLElement>('[data-cockpit-node="branch"]')!;
    fireEvent.click(within(branch).getByRole("button", { name: enCockpit.plan_tree.more }));
    fireEvent.click(screen.getByRole("menuitem", { name: enCockpit.plan_tree.delete }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = await within(dialog).findByRole("button", { name: "Delete module" });
    await waitFor(() => expect(confirm).toBeDisabled());
    expect(mocks.deleteModule).not.toHaveBeenCalled();
  });

  it("fills a work item's bar from its issues, not the typed number", () => {
    const taskCounts = new Map([["leaf", { node_id: "leaf", primary_total: 4, reference_total: 0, active: 1, done: 3, closed: 0 }]]);
    const { viewport, update } = show({ renderAllRows: true, taskCounts });
    // The bars live in the timeline pane, a sibling of the name column.
    const tail = () => viewport.querySelector<HTMLElement>('[data-cockpit-node="leaf"] [data-progress]')!;
    // 75% done leaves a 25% veil; the typed 40 would leave 60%.
    expect(tail()).toHaveAttribute("data-progress", "75");
    expect(tail().style.width).toBe("25%");
    // The wiring is what makes it so: without the counts the bar falls back.
    update({ taskCounts: new Map() });
    expect(tail()).toHaveAttribute("data-progress", "40");
  });

  // One board, every gantt read that has to take the same number: A's four
  // issues are three done, B is typed at 40 with no date, C's issues are all
  // cancelled. (75 + 40 + 60) / 3 = 58 on the direction, the project row and
  // the annual objective.
  function issueBoard() {
    return {
      ...board,
      cockpit: { ...board.cockpit, goal_date: "2026-12-31" },
      nodes: [
        node("root", { code: "L1-03", name: "Programme" }),
        node("branch", { code: "03.09", parent_id: "root", name: "Direction", kind: "module", module_id: "mod-branch" }),
        node("leaf", { code: "03.09.01", parent_id: "branch", name: "A", status: "In progress", progress: 10 }),
        node("leaf2", { code: "03.09.02", parent_id: "branch", name: "B", status: "In progress", progress: 40, end_date: null }),
        node("branch2", { code: "03.10", parent_id: "root", name: "Direction two", kind: "module", module_id: "mod-branch-2" }),
        node("leaf3", { code: "03.10.01", parent_id: "branch2", name: "C", status: "In progress", progress: 60, end_date: null }),
      ],
    };
  }
  const issueCounts = new Map([
    ["leaf", { node_id: "leaf", primary_total: 4, reference_total: 0, active: 1, done: 3, closed: 0 }],
    ["leaf3", { node_id: "leaf3", primary_total: 4, reference_total: 0, active: 0, done: 0, closed: 4 }],
  ]);

  it("marks a core date from the issue counts, not the typed number", async () => {
    // Without the counts A reads its typed 10% and B has no date, so nothing
    // is coming up; with them A clears the floor at 75.
    const { update } = show({ board: issueBoard(), renderAllRows: true });
    expect(screen.queryByRole("button", { name: /coming up/ })).toBeNull();
    update({ taskCounts: issueCounts });
    const marker = screen.getByRole("button", { name: /coming up/ });
    fireEvent.click(marker);
    const dialog = await screen.findByRole("dialog");
    // The marker's own list quotes the ratio the board shows.
    expect(within(dialog).getByText(/Progress: 75%/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Progress: 10%/)).toBeNull();
  });

  it("reads every gantt progress from the issue counts", () => {
    const { tree, viewport } = show({ board: issueBoard(), renderAllRows: true, taskCounts: issueCounts });
    // The direction row's column and its summary bar: (75 + 40) / 2 = 58.
    const branch = tree.querySelector<HTMLElement>('[data-cockpit-node="branch"]')!;
    expect(within(branch).getByText("58%")).toBeInTheDocument();
    expect(viewport.querySelector<HTMLElement>('[data-cockpit-node="branch"] [data-progress]'))
      .toHaveAttribute("data-progress", "58");
    // The project row's annual-objective chip: (75 + 40 + 60) / 3 = 58.
    const root = tree.querySelector<HTMLElement>('[data-cockpit-node="root"]')!;
    expect(within(root).getByText("58%")).toBeInTheDocument();
    // C's issues are all cancelled: no countable ratio, so the typed field
    // stays — a bare primary_total > 0 would have hidden it.
    const leaf3 = tree.querySelector<HTMLElement>('[data-cockpit-node="leaf3"]')!;
    expect(within(leaf3).getByRole("button", { name: "Progress" })).toBeInTheDocument();
  });

  it("draws no typed progress on a structure row nobody has broken down", () => {
    const withEmptyModule = {
      ...board,
      nodes: [...nodes, node("empty", { code: "03.10", parent_id: "root", name: "Empty direction", kind: "module", progress: 40 })],
    };
    const { tree } = show({ board: withEmptyModule, renderAllRows: true });
    const row = tree.querySelector<HTMLElement>('[data-cockpit-node="empty"]')!;
    // An empty L1/L2 row is structure, not a work item: it has no typed
    // progress, only the roll-up that has nothing in it yet.
    expect(row.querySelector("[data-progress-empty]")).toHaveTextContent("—");
    expect(within(row).queryByRole("button", { name: "Progress" })).toBeNull();
  });

  it("locks the structure controls on a board that is not reconciled yet", () => {
    const unreconciled = { ...board, cockpit: { ...board.cockpit, plan_reconciled_at: null } };
    const { tree } = show({ board: unreconciled, renderAllRows: true });
    expect(within(tree).queryByRole("button", { name: enCockpit.plan_tree.add_child })).toBeNull();
    expect(within(tree).queryByRole("button", { name: enCockpit.plan_tree.more })).toBeNull();
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
