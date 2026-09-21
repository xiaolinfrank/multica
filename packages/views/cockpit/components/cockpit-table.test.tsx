import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
function show(overrides: Partial<CockpitTableProps> = {}) {
  const board: CockpitBoard = {
    cockpit: { id: "cp", workspace_id: "ws", title: "Board", goal_title: "", goal_date: null,
      summary_overall: "", summary_next: "", summary_support: "", basis: "", created_at: "", updated_at: "" },
    nodes, payments: [], issue_links: [], milestones: [], meetings: [],
  };
  const onSelect = vi.fn();
  const props: CockpitTableProps = { board, mode: "tasks", query: "", rootIds: new Set(), selectedId: null,
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
        summary_overall: "", summary_next: "", summary_support: "", basis: "", created_at: "", updated_at: "" },
      nodes: [node({ id: "leaf", code: "01", name: "Complete core fields", progress: 0 })],
      payments: [], issue_links: [], milestones: [], meetings: [],
    } });
    expect(screen.getByRole("button", { name: "OK" })).toHaveAttribute("title", expect.stringContaining("Suggested additions: 10"));
    expect(screen.getByRole("button", { name: "OK" }).title).not.toContain("Required fields missing");
    expect(screen.queryByText(/Remind/)).not.toBeInTheDocument();
  });

  it("labels core gaps separately from suggested additions", () => {
    show({ board: {
      cockpit: { id: "cp", workspace_id: "ws", title: "Board", goal_title: "", goal_date: null,
        summary_overall: "", summary_next: "", summary_support: "", basis: "", created_at: "", updated_at: "" },
      nodes: [node({ id: "leaf", code: "01", owner: "" })],
      payments: [], issue_links: [], milestones: [], meetings: [],
    } });
    const badge = screen.getByRole("button", { name: /Remind/ });
    expect(badge.title).toContain("Required fields missing: 1: Owner");
    expect(badge.title).toContain("Suggested additions: 10:");
  });

  it("does not fall back to unrelated roots when a selected branch is missing", () => {
    show({ rootIds: new Set(["removed-root"]) });
    expect(screen.getAllByRole("row")).toHaveLength(1);
  });
});
