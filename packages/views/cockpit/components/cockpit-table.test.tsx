vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams() }) }));
// jsdom gives the scroll container a zero rect, and the virtualizer then
// renders no data rows at all — render every row so the assertions read the
// table content, not the viewport.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number; getItemKey?: (index: number) => string | number }) => {
    const size = 56;
    const items = Array.from({ length: options.count }, (_, index) => ({ index, start: index * size, end: (index + 1) * size, size, key: options.getItemKey ? options.getItemKey(index) : index }));
    return { getVirtualItems: () => items, getTotalSize: () => options.count * size, measureElement: () => undefined };
  },
}));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import type { CockpitBoard, CockpitNode } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
import { buildCockpitDisplayCodesFromIndex } from "@multica/core/cockpit";
import { CockpitTable, type CockpitTableProps } from "./cockpit-table";

function node(overrides: Partial<CockpitNode> & { id: string; code: string }): CockpitNode {
  return {
    cockpit_id: "cp", parent_id: null, name: overrides.code, position: 0, color: "",
    owner: "Li", collaborators: "", start_date: "2026-09-01", end_date: "2026-09-30",
    status: "In progress", progress: 0, deliverable: "", dependencies: "", note: "",
    current_progress: "", vendor: "", budget_category: "", budget_amount: null,
    exec_status: "", contract: "", source: "", updated_by_type: "", updated_by_id: null,
    created_at: "", updated_at: "", ...overrides,
  };
}
const nodes = [
  node({ id: "root", code: "L1-03", name: "Module" }),
  node({ id: "branch", code: "historic-branch", parent_id: "root", name: "Branch" }),
  node({ id: "leaf", code: "historic-task-18", parent_id: "branch", name: "Execution task", progress: 40, note: "hidden diagnostic needle" }),
];
function show(overrides: Partial<Omit<CockpitTableProps, "board">> & { board?: CockpitBoard } = {}) {
  const board: CockpitBoard = {
    cockpit: { id: "cp", workspace_id: "ws", title: "Board", goal_title: "", goal_date: null,
      summary_overall: "", summary_next: "", summary_support: "", basis: "", meeting_assignee_type: "", meeting_assignee_id: null, meeting_project_id: null, meeting_module_id: null, meeting_node_id: null, meeting_dir: "", created_at: "", updated_at: "" },
    nodes, payments: [], issue_links: [], milestones: [], meetings: [], meeting_issues: [], meeting_nodes: [],
  };
  const onSelect = vi.fn();
  const props: CockpitTableProps = { board, contextNodeIds: new Set(), taskCounts: new Map(), displayCodes: buildCockpitDisplayCodesFromIndex(overrides.board?.nodes ?? nodes), mode: "tasks", query: "", rootIds: new Set(), selectedId: null,
    onSelect, onPatchNode: vi.fn(), statusSuggestions: [], execStatusSuggestions: [],
    budgetCategorySuggestions: [], ownerSuggestions: [], vendorSuggestions: [], ...overrides };
  const view = render(<I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>
    <input aria-label="Search the board" />
    <CockpitTable {...props} />
  </I18nProvider>);
  return { ...view, onSelect };
}

describe("CockpitTable execution rows", () => {
  it("shows only leaves with positional codes and aligned review columns", () => {
    show();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /03\.01\.01/ })).toBeInTheDocument();
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.slice(0, 10).map((h) => h.textContent)).toEqual([
      "Code", "Name", "L1", "L2", "Owner", "Start", "End", "Status", "Progress", "Check",
    ]);
    expect(headers).toHaveLength(within(table).getAllByRole("row")[1]!.children.length);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
  });

  it("finds hidden fields and Enter locates the first execution match once", () => {
    const { onSelect } = show({ query: "diagnostic needle" });
    expect(screen.getByRole("status")).toHaveTextContent("1 matches");
    expect(screen.getByRole("button", { name: /03\.01\.01/ })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search the board" }), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("leaf");
  });

  it("searches display codes without changing the stored task address", () => {
    show({ query: "03.01.01" });
    expect(screen.getByText("03.01.01")).toBeInTheDocument();
    expect(screen.getByTitle("historic-task-18")).toBeInTheDocument();
  });

  it("does not treat optional missing fields or zero progress as core warnings", () => {
    show({ board: {
      cockpit: { id: "cp", workspace_id: "ws", title: "Board", goal_title: "", goal_date: null,
        summary_overall: "", summary_next: "", summary_support: "", basis: "", meeting_assignee_type: "", meeting_assignee_id: null, meeting_project_id: null, meeting_module_id: null, meeting_node_id: null, meeting_dir: "", created_at: "", updated_at: "" },
      nodes: [node({ id: "leaf", code: "01", name: "Complete core fields", progress: 0 })],
      payments: [], issue_links: [], milestones: [], meetings: [], meeting_issues: [], meeting_nodes: [],
    } });
    // Nine suggestions: the eight soft fields plus the unset budget. Linked
    // issues are suggested only when the server positively reports zero
    // links — an unknown count (empty taskCounts map) must not nag.
    expect(screen.getByRole("button", { name: "OK" })).toHaveAttribute("title", expect.stringContaining("Suggested additions: 9"));
    expect(screen.getByRole("button", { name: "OK" }).title).not.toContain("Required fields missing");
    expect(screen.queryByText(/Remind/)).not.toBeInTheDocument();
  });

  it("labels core gaps separately from suggested additions", () => {
    show({ board: {
      cockpit: { id: "cp", workspace_id: "ws", title: "Board", goal_title: "", goal_date: null,
        summary_overall: "", summary_next: "", summary_support: "", basis: "", meeting_assignee_type: "", meeting_assignee_id: null, meeting_project_id: null, meeting_module_id: null, meeting_node_id: null, meeting_dir: "", created_at: "", updated_at: "" },
      nodes: [node({ id: "leaf", code: "01", owner: "" })],
      payments: [], issue_links: [], milestones: [], meetings: [], meeting_issues: [], meeting_nodes: [],
    } });
    const badge = screen.getByRole("button", { name: /Remind/ });
    expect(badge.title).toContain("Required fields missing: 1: Owner");
    expect(badge.title).toContain("Suggested additions: 9:");
  });

  it("keeps six-decimal monetary precision and a visible unit in the ledger totals", () => {
    const { container } = show({ mode: "finance", board: {
      cockpit: { id: "cp", workspace_id: "ws", title: "Board", goal_title: "", goal_date: null,
        summary_overall: "", summary_next: "", summary_support: "", basis: "", meeting_assignee_type: "", meeting_assignee_id: null, meeting_project_id: null, meeting_module_id: null, meeting_node_id: null, meeting_dir: "", created_at: "", updated_at: "" },
      nodes: [node({ id: "paid", code: "01", budget_amount: 50.068608, exec_status: "paid" }), node({ id: "planned", code: "02", budget_amount: 1.000001 })],
      payments: [], issue_links: [], milestones: [], meetings: [], meeting_issues: [], meeting_nodes: [],
    } });
    const totals = container.querySelector(".cockpit-ledger-totals")!;
    expect(totals).toHaveTextContent("51.068609");
    expect(totals).toHaveTextContent("50.068608");
    expect(totals.querySelectorAll(".cockpit-currency-unit")).toHaveLength(2);
    expect(totals).toHaveTextContent(enCockpit.finance.amount_unit);
    expect(screen.getByText(enCockpit.finance.actual_basis)).toBeVisible();
  });

  it("does not fall back to unrelated roots when a selected branch is missing", () => {
    show({ rootIds: new Set(["removed-root"]) });
    expect(screen.getAllByRole("row")).toHaveLength(1);
  });
});

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", () => ({ useReducedMotion: () => motion.reduced }));
vi.mock("./use-cockpit-scroll-memory", () => ({ useCockpitScrollMemory: () => {} }));

describe("CockpitTable narrow containers and motion", () => {
  let width = 320;
  let resize: () => void;
  beforeEach(() => {
    width = 320; motion.reduced = false;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    vi.stubGlobal("ResizeObserver", class {
      constructor(read: () => void) { resize = read; }
      observe() {} disconnect() {}
    });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("lets names and all business columns scroll while retaining the code address", () => {
    const { onSelect } = show();
    const headers = screen.getAllByRole("columnheader");
    const row = screen.getAllByRole("row")[1]!;
    expect(headers).toHaveLength(21);
    expect(headers[1]!.style.left).toBe("");
    expect((row.children[0] as HTMLElement).style.width).toBe("100px");
    expect((row.children[1] as HTMLElement).style.left).toBe("");
    expect(screen.getByRole("columnheader", { name: "Deliverable" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Budget" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open 03.01.01" }));
    expect(onSelect).toHaveBeenCalledWith("leaf");
    width = 1440;
    act(() => resize());
    expect(headers[1]!.style.left).toBe("100px");
    expect((row.children[1] as HTMLElement).style.left).toBe("100px");
    expect(screen.getAllByRole("columnheader")).toHaveLength(21);
  });

  it.each([false, true])("locates search results with reduced motion=%s without changing the action", (reduced) => {
    motion.reduced = reduced;
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    const { onSelect } = show({ query: "diagnostic needle" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search the board" }), { key: "Enter" });
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "center", behavior: reduced ? "auto" : "smooth" });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("leaf");
  });
});
