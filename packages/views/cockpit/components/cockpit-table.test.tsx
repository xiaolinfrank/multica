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
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import type { CockpitBoard, CockpitNode } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
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
  const props: CockpitTableProps = { board, contextNodeIds: new Set(), taskCounts: new Map(), query: "", rootIds: new Set(), selectedId: null,
    onSelect, onPatchNode: vi.fn(), execStatusSuggestions: [],
    budgetCategorySuggestions: [], vendorSuggestions: [], ...overrides };
  const view = render(<I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>
    <input aria-label="Search the board" />
    <CockpitTable {...props} />
  </I18nProvider>);
  return { ...view, onSelect };
}

describe("CockpitTable execution rows", () => {
  it("keeps six-decimal monetary precision and a visible unit in the ledger totals", () => {
    const { container } = show({ board: {
      cockpit: { id: "cp", workspace_id: "ws", title: "Board", goal_title: "", goal_date: null,
        summary_overall: "", summary_next: "", summary_support: "", basis: "", meeting_assignee_type: "", meeting_assignee_id: null, meeting_project_id: null, meeting_module_id: null, meeting_node_id: null, meeting_dir: "", created_at: "", updated_at: "" },
      nodes: [node({ id: "paid", code: "01", budget_amount: 50.068608, exec_status: "paid" }), node({ id: "planned", code: "02", budget_amount: 1.000001 })],
      // One instalment each: the ledger's figures are read from instalments,
      // and the budget is counted once per node, not per line.
      payments: [
        { id: "p1", node_id: "paid", label: "已付", pay_date: "2026-01-10", amount: 50.068608, position: 0 },
        { id: "p2", node_id: "planned", label: "待付", pay_date: "2026-02-10", amount: 1.000001, position: 0 },
      ],
      issue_links: [], milestones: [], meetings: [], meeting_issues: [], meeting_nodes: [],
    } });
    const totals = container.querySelector(".cockpit-ledger-totals")!;
    // Ledger totals follow the instalment basis: budget once per node, the
    // spend figure is the instalment sum. Both are 51.068609 here.
    expect(totals).toHaveTextContent("51.068609");
    expect(totals.querySelectorAll(".cockpit-currency-unit")).toHaveLength(2);
    expect(totals).toHaveTextContent(enCockpit.finance.amount_unit);
    expect(screen.getByText(enCockpit.finance.actual_basis)).toBeVisible();
  });

  it("does not fall back to unrelated roots when a selected branch is missing", () => {
    show({ rootIds: new Set(["removed-root"]) });
    expect(screen.getAllByRole("row")).toHaveLength(1);
  });
});

describe("CockpitTable instalment rows", () => {
  it("shows every instalment, including unpaid ones, with its own date and status", () => {
    const paidNode = node({ id: "paid", code: "01.01", name: "Paid task", budget_amount: 100, exec_status: "完全支付" });
    const unpaidNode = node({ id: "unpaid", code: "01.02", name: "Unpaid task", budget_amount: 200, exec_status: "合同已定" });
    const board: CockpitBoard = {
      cockpit: { id: "cp", workspace_id: "ws", title: "Board", goal_title: "", goal_date: null,
        summary_overall: "", summary_next: "", summary_support: "", basis: "", meeting_assignee_type: "", meeting_assignee_id: null, meeting_project_id: null, meeting_module_id: null, meeting_node_id: null, meeting_dir: "", created_at: "", updated_at: "" },
      nodes: [paidNode, unpaidNode],
      payments: [
        { id: "p1", node_id: "paid", label: "First", pay_date: "2026-01-10", amount: 30, position: 0 },
        { id: "p2", node_id: "paid", label: "Second", pay_date: "2026-02-10", amount: 20, position: 1 },
        { id: "p3", node_id: "unpaid", label: "Contract payment", pay_date: "2026-03-10", amount: 80, position: 0 },
      ],
      issue_links: [], milestones: [], meetings: [], meeting_issues: [], meeting_nodes: [],
    };
    show({ board });
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(within(rows[1]!).getByText("First")).toBeInTheDocument();
    expect(within(rows[1]!).getAllByText("2026-01-10")).toHaveLength(2);
    expect(within(rows[1]!).getByText("30")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Paid")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Second")).toBeInTheDocument();
    expect(within(rows[2]!).getAllByText("2026-02-10")).toHaveLength(2);
    expect(within(rows[2]!).getByText("20")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Paid")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("Contract payment")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("2026-03-10")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("80")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("Scheduled")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("3 lines");
    // Budget counted once per node (100+200); the spend figure is every
    // instalment (30+20+80).
    const totals = document.querySelector(".cockpit-ledger-totals")!;
    expect(totals).toHaveTextContent("300");
    expect(totals).toHaveTextContent("130");
    expect(within(screen.getByRole("table")).getAllByRole("columnheader")).toHaveLength(rows[1]!.children.length);
  });
});
