// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import enCockpit from "../locales/en/cockpit.json";

const plan: { cockpit: { id: string; title: string; plan_reconciled_at: string | null }; nodes: Record<string, unknown>[]; task_counts: Record<string, unknown>[]; context_node_ids: string[]; payments: never[]; milestones: never[]; node_index: never[]; meetings: never[]; meeting_issues: never[]; meeting_nodes: never[]; issue_links: never[] } = {
  cockpit: { id: "cp", title: "Programme", plan_reconciled_at: null },
  nodes: [
    { id: "p1", code: "01", name: "项目一", kind: "project", position: 0, project_id: "proj-1" },
    { id: "m1", code: "01.01", name: "模块一", kind: "module", parent_id: "p1", position: 0, module_id: "mod-1", project_id: "proj-1" },
    { id: "w1", code: "01.01.01", name: "工作项一", kind: "work_item", parent_id: "m1", position: 0 },
  ],
  task_counts: [{ node_id: "w1", primary_total: 2, reference_total: 0, active: 1, done: 1, closed: 0 }],
  context_node_ids: [],
  payments: [], milestones: [], node_index: [], meetings: [], meeting_issues: [], meeting_nodes: [], issue_links: [],
};

const apiMock = vi.hoisted(() => ({
  getCockpitPlan: vi.fn(async () => plan),
  getCockpitNodeTasks: vi.fn(async () => ({ node_id: "w1", items: [
    { id: "i1", identifier: "MUL-1", title: "首个任务", status: "todo", status_category: "unstarted", priority: "none",
      assignee_type: null, assignee_id: null, assignee_name: "", due_date: "2026-10-01", project_id: null, module_id: null,
      primary_node_id: "w1", primary_node_code: "01.01.01", primary_node_name: "工作项一" },
  ], total: 3, filtered_total: 3, next_cursor: null })),
  createModule: vi.fn(async (data: { title: string }) => ({ id: "m-new", title: data.title, project_id: "proj-1" })),
}));
vi.mock("@multica/core/api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@multica/core/api");
  return { ...actual, api: apiMock, setApiInstance: () => {} };
});
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("../navigation", () => ({ useNavigation: () => ({ push: vi.fn(), searchParams: new URLSearchParams() }), AppLink: (p: never) => p }));

import { PlanTree } from "./plan-tree";
import { useCockpitScopeViewStore } from "@multica/core/cockpit";

function show(props: Partial<React.ComponentProps<typeof PlanTree>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>
      <QueryClientProvider client={qc}>
        <PlanTree wsId="ws-1" scope={{ projectId: null, moduleId: null }} query="" readOnly={false} selectedId={null} onSelect={() => {}} {...props} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}
afterEach(() => {
  vi.clearAllMocks();
  // The fold state lives in the shared view store; a test that expands a row
  // must not hand the next one a different tree.
  useCockpitScopeViewStore.getState().reset();
});

describe("PlanTree", () => {
  it("shows the unreconciled notice and disables the structure buttons", async () => {
    show();
    expect(await screen.findByRole("status")).toHaveTextContent(enCockpit.plan_tree.unreconciled);
    // Read-only structure: no add/menu affordances on any row.
    expect(screen.queryByRole("button", { name: enCockpit.plan_tree.add_child })).toBeNull();
    expect(screen.queryByRole("button", { name: enCockpit.plan_tree.more })).toBeNull();
  });

  it("renders the three levels in plan order with the row's own code", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce({ ...plan, cockpit: { ...plan.cockpit, plan_reconciled_at: "2026-11-20T00:00:00Z" } });
    show();
    const rows = await screen.findAllByRole("row");
    expect(rows.map((r) => r.getAttribute("data-kind"))).toEqual(["project", "module", "work_item"]);
    expect(within(rows[2]!).getByText("01.01.01")).toBeInTheDocument();
  });

  it("loads a work item's issues lazily and points at the remainder", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce({ ...plan, cockpit: { ...plan.cockpit, plan_reconciled_at: "2026-11-20T00:00:00Z" } });
    show();
    // Issues are not part of the tree read: expanding the work item loads them.
    const rows = await screen.findAllByRole("row");
    const workItem = rows.find((r) => r.getAttribute("data-kind") === "work_item")!;
    fireEvent.click(within(workItem).getByRole("button", { name: enCockpit.plan_tree.expand }));
    expect(await screen.findByText(/首个任务/)).toBeInTheDocument();
    expect(apiMock.getCockpitNodeTasks).toHaveBeenCalledWith("w1", expect.objectContaining({ page_size: 20, relation: "primary" }), expect.anything());
    expect(screen.getByText("2 more · open in the list")).toBeInTheDocument();
  });

  it("creates a module inline from the project row", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce({ ...plan, cockpit: { ...plan.cockpit, plan_reconciled_at: "2026-11-20T00:00:00Z" } });
    show();
    fireEvent.click((await screen.findAllByRole("button", { name: enCockpit.plan_tree.add_child }))[0]!);
    const field = screen.getByPlaceholderText(enCockpit.plan_tree.new_module);
    fireEvent.change(field, { target: { value: "新模块" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(apiMock.createModule).toHaveBeenCalledWith(expect.objectContaining({ title: "新模块", project_id: "proj-1" })));
  });

  it("moves a cursor with the arrow keys and hands the row over on Enter", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce({ ...plan, cockpit: { ...plan.cockpit, plan_reconciled_at: "2026-11-20T00:00:00Z" } });
    const opened: string[] = [];
    show({ onSelect: (id) => opened.push(id) });
    const grid = await screen.findByRole("treegrid");
    const rowOf = (kind: string) => screen.getAllByRole("row").find((row) => row.getAttribute("data-kind") === kind)!;
    expect(rowOf("project")).toHaveAttribute("aria-level", "1");
    // The cursor starts on the first row; one step down lands on the module.
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    await waitFor(() => expect(rowOf("module")).toHaveAttribute("data-active", "true"));
    // Arrowing is navigation, not selection: the page is not told yet.
    expect(opened).toEqual([]);
    fireEvent.keyDown(rowOf("module"), { key: "Enter" });
    expect(opened).toEqual(["m1"]);
  });

  it("expands and collapses the row under the cursor", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce({ ...plan, cockpit: { ...plan.cockpit, plan_reconciled_at: "2026-11-20T00:00:00Z" } });
    show();
    const grid = await screen.findByRole("treegrid");
    const workItem = () => screen.getAllByRole("row").find((row) => row.getAttribute("data-kind") === "work_item")!;
    await waitFor(() => expect(workItem()).toHaveAttribute("aria-expanded", "false"));
    // Put the cursor on the work item (project → module → work item).
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    await waitFor(() => expect(workItem()).toHaveAttribute("data-active", "true"));
    fireEvent.keyDown(workItem(), { key: "ArrowRight" });
    expect(await screen.findByText(/首个任务/)).toBeInTheDocument();
    fireEvent.keyDown(workItem(), { key: "ArrowLeft" });
    await waitFor(() => expect(workItem()).toHaveAttribute("aria-expanded", "false"));
  });

  it("renders the plan's columns in table mode, with the issue tally", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce({ ...plan, cockpit: { ...plan.cockpit, plan_reconciled_at: "2026-11-20T00:00:00Z" } });
    show({ variant: "table", onPatchNode: () => {}, ownerSuggestions: ["李林"] });
    expect(await screen.findByRole("columnheader", { name: enCockpit.plan_tree.column_owner })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: enCockpit.plan_tree.column_dates })).toBeInTheDocument();
    const workItem = screen.getAllByRole("row").find((row) => row.getAttribute("data-kind") === "work_item")!;
    // 2 primary, 0 reference — the same tally the gantt and the finance grid quote.
    expect(within(workItem).getByText("2 primary · 0 reference")).toBeInTheDocument();
  });
});
