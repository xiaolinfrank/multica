// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import enCockpit from "../locales/en/cockpit.json";
import enProjects from "../locales/en/projects.json";

const plan: {
  cockpit: { id: string; title: string; plan_reconciled_at: string | null };
  nodes: Record<string, unknown>[];
  task_counts: Record<string, unknown>[];
  context_node_ids: string[];
  payments: Record<string, unknown>[];
  milestones: never[]; node_index: never[]; meetings: never[]; meeting_issues: never[]; meeting_nodes: never[]; issue_links: never[];
} = {
  cockpit: { id: "cp", title: "Programme", plan_reconciled_at: null },
  nodes: [
    { id: "p1", code: "01", name: "项目一", kind: "project", position: 0, project_id: "proj-1" },
    { id: "m1", code: "01.01", name: "模块一", kind: "module", parent_id: "p1", position: 0, module_id: "mod-1", project_id: "proj-1" },
    { id: "w1", code: "01.01.01", name: "工作项一", kind: "work_item", parent_id: "m1", position: 0 },
    { id: "m2", code: "01.02", name: "模块二", kind: "module", parent_id: "p1", position: 1, module_id: "mod-2", project_id: "proj-1" },
    { id: "w2", code: "01.02.01", name: "工作项二", kind: "work_item", parent_id: "m2", position: 0 },
  ],
  task_counts: [
    { node_id: "w1", primary_total: 2, reference_total: 0, active: 1, done: 1, closed: 0 },
    { node_id: "w2", primary_total: 0, reference_total: 0, active: 0, done: 0, closed: 0 },
  ],
  context_node_ids: [],
  payments: [{ id: "pay-1", node_id: "m1", label: "第 1 笔", pay_date: "2026-10-01", amount: 10, position: 0 }],
  milestones: [], node_index: [], meetings: [], meeting_issues: [], meeting_nodes: [], issue_links: [],
};

const navMock = vi.hoisted(() => ({ push: vi.fn() }));
const apiMock = vi.hoisted(() => ({
  getCockpitPlan: vi.fn(async () => plan),
  getCockpitNodeTasks: vi.fn(async () => ({ node_id: "w1", items: [
    { id: "i1", identifier: "MUL-1", title: "首个任务", status: "todo", status_category: "unstarted", priority: "none",
      assignee_type: null, assignee_id: null, assignee_name: "", due_date: "2026-10-01", project_id: null, module_id: null,
      primary_node_id: "w1", primary_node_code: "01.01.01", primary_node_name: "工作项一" },
  ], total: 3, filtered_total: 3, next_cursor: null })),
  createModule: vi.fn(async (data: { title: string }) => ({ id: "m-new", title: data.title, project_id: "proj-1" })),
  createCockpitWorkItem: vi.fn(async (body: { name: string; creation_key?: string }) => ({ id: "w-new", name: body.name, code: "01.01.09" })),
  deleteCockpitNode: vi.fn(async () => {}),
  deleteModule: vi.fn(async () => {}),
  moveCockpitWorkItem: vi.fn(async (id: string, patch: { parent_id: string }) => ({ id, parent_id: patch.parent_id, code: "01.02.09" })),
  updateCockpitNode: vi.fn(async (id: string, patch: { name?: string }) => ({ id, name: patch.name, code: "01.01.01" })),
  updateModule: vi.fn(async (id: string, data: { title: string }) => ({ id, title: data.title })),
  updateProject: vi.fn(async (id: string, data: { title: string }) => ({ id, title: data.title })),
  getContainerOperationBasis: vi.fn(async (wsId: string, kind: string, id: string) => ({
    workspace_id: wsId, schema_version: 1, generated_at: "2026-11-21T00:00:00Z", resource_kind: kind,
    resource_id: id, availability: "available", resource_revision: 1,
    delete: { state: "allowed", reason_codes: [] }, structural_edit: { state: "allowed", reason_codes: [] },
    add_child: { state: "allowed", reason_codes: [] }, targets: [], targets_total: 0,
  })),
}));
vi.mock("@multica/core/api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@multica/core/api");
  return { ...actual, api: apiMock, setApiInstance: () => {} };
});
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({
  issueDetail: (id: string) => `/ws/issues/${id}`,
  projectDetail: (id: string) => `/ws/projects/${id}`,
}) }));
vi.mock("../navigation", () => ({
  useNavigation: () => ({ push: navMock.push, searchParams: new URLSearchParams() }),
  AppLink: (p: never) => p,
}));

import { PlanTree } from "./plan-tree";
import { cockpitPlanOptions, useCockpitScopeViewStore } from "@multica/core/cockpit";
import { useModalStore } from "@multica/core/modals";

const reconciled = { ...plan, cockpit: { ...plan.cockpit, plan_reconciled_at: "2026-11-20T00:00:00Z" } };

function show(props: Partial<React.ComponentProps<typeof PlanTree>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, projects: enProjects } }}>
      <QueryClientProvider client={qc}>
        <PlanTree wsId="ws-1" scope={{ projectId: null, moduleId: null }} query="" readOnly={false} selectedId={null} onSelect={() => {}} {...props} />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { ...view, qc };
}
const rowOf = (kind: string) => screen.getAllByRole("row").find((row) => row.getAttribute("data-kind") === kind)!;
const rowsOf = (kind: string) => screen.getAllByRole("row").filter((row) => row.getAttribute("data-kind") === kind);

afterEach(() => {
  vi.clearAllMocks();
  navMock.push.mockReset();
  // The fold state lives in the shared view store; a test that expands a row
  // must not hand the next one a different tree.
  useCockpitScopeViewStore.getState().reset();
});

describe("PlanTree", () => {
  it("shows the unreconciled notice, says who resolves it, and disables the structure buttons", async () => {
    show();
    expect(await screen.findByRole("status")).toHaveTextContent(enCockpit.plan_tree.unreconciled);
    // Read-only structure: no add/menu affordances on any row.
    expect(screen.queryByRole("button", { name: enCockpit.plan_tree.add_child })).toBeNull();
    expect(screen.queryByRole("button", { name: enCockpit.plan_tree.more })).toBeNull();
  });

  it("renders the three levels in plan order with the row's own code", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce(reconciled);
    show();
    const rows = await screen.findAllByRole("row");
    expect(rows.map((r) => r.getAttribute("data-kind"))).toEqual([
      "project", "module", "work_item", "module", "work_item",
    ]);
    expect(within(rows[2]!).getByText("01.01.01")).toBeInTheDocument();
  });

  it("opens with every work item closed and reads no issues until one is opened", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce(reconciled);
    show();
    await screen.findAllByRole("row");
    expect(rowsOf("work_item").map((row) => row.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
    // A closed work item is not a read: first paint of a scope fires none.
    expect(apiMock.getCockpitNodeTasks).not.toHaveBeenCalled();
  });

  it("loads a work item's issues lazily and points the remainder at the project list", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce(reconciled);
    show();
    await screen.findAllByRole("row");
    // Issues are not part of the tree read: expanding the work item loads them.
    const workItem = rowsOf("work_item")[0]!;
    fireEvent.click(within(workItem).getByRole("button", { name: enCockpit.plan_tree.expand }));
    expect(await screen.findByText(/首个任务/)).toBeInTheDocument();
    expect(apiMock.getCockpitNodeTasks).toHaveBeenCalledWith("w1", expect.objectContaining({ page_size: 20, relation: "primary" }), expect.anything());
    // S5 opens the project page narrowed to the work item's module (S6 will
    // hand over `?node=` instead); the work item id is not an issue id.
    fireEvent.click(screen.getByText("2 more · open in the list"));
    expect(navMock.push).toHaveBeenCalledWith("/ws/projects/proj-1?module=mod-1");
  });

  it("keeps work items closed after a scope switch", async () => {
    apiMock.getCockpitPlan.mockResolvedValue(reconciled);
    const { rerender } = show();
    await screen.findAllByRole("row");
    rerender(
      <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, projects: enProjects } }}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <PlanTree wsId="ws-1" scope={{ projectId: "proj-1", moduleId: "mod-1" }} query="" readOnly={false} selectedId={null} onSelect={() => {}} />
        </QueryClientProvider>
      </I18nProvider>,
    );
    await waitFor(() => expect(rowsOf("work_item").length).toBeGreaterThan(0));
    expect(rowsOf("work_item").every((row) => row.getAttribute("aria-expanded") === "false")).toBe(true);
    expect(apiMock.getCockpitNodeTasks).not.toHaveBeenCalled();
  });

  it("keeps a work item that arrives after mount closed", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce(reconciled);
    const { qc } = show();
    await screen.findAllByRole("row");
    const next = structuredClone(reconciled);
    next.nodes.push({ id: "w3", code: "01.02.02", name: "工作项三", kind: "work_item", parent_id: "m2", position: 1 });
    act(() => {
      qc.setQueryData(cockpitPlanOptions("ws-1", { projectId: null, moduleId: null }).queryKey, next as never);
    });
    await waitFor(() => expect(rowsOf("work_item")).toHaveLength(3));
    // The new row was never opened, so it is closed — and nothing was read.
    expect(rowsOf("work_item").at(-1)).toHaveAttribute("aria-expanded", "false");
    expect(apiMock.getCockpitNodeTasks).not.toHaveBeenCalled();
  });

  it("filters to the search hits and the parents that place them", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce(reconciled);
    show({ query: "工作项二" });
    await screen.findAllByRole("row");
    const rows = screen.getAllByRole("row");
    // The non-matching sibling 工作项一 is gone; the path to the hit stays.
    expect(rows.map((r) => r.getAttribute("data-kind"))).toEqual(["project", "module", "work_item"]);
    expect(within(rows[2]!).getByText("01.02.01")).toBeInTheDocument();
  });

  it("creates a module inline from the project row", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce(reconciled);
    show();
    fireEvent.click((await screen.findAllByRole("button", { name: enCockpit.plan_tree.add_child }))[0]!);
    const field = screen.getByPlaceholderText(enCockpit.plan_tree.new_module);
    fireEvent.change(field, { target: { value: "新模块" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(apiMock.createModule).toHaveBeenCalledWith(expect.objectContaining({ title: "新模块", project_id: "proj-1" })));
  });

  it("reuses the creation key when a work-item create is retried", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce(reconciled);
    apiMock.createCockpitWorkItem.mockRejectedValueOnce(new Error("network down"));
    show();
    await screen.findAllByRole("row");
    // The module row's "+" adds a work item.
    const moduleRow = rowOf("module");
    fireEvent.click(within(moduleRow).getByRole("button", { name: enCockpit.plan_tree.add_child }));
    const field = screen.getByPlaceholderText(enCockpit.plan_tree.new_work_item);
    fireEvent.change(field, { target: { value: "新工作项" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("network down");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(apiMock.createCockpitWorkItem).toHaveBeenCalledTimes(2));
    const first = apiMock.createCockpitWorkItem.mock.calls[0]![0] as { creation_key: string };
    const second = apiMock.createCockpitWorkItem.mock.calls[1]![0] as { creation_key: string };
    // A retry replays the row the server may already have made.
    expect(second.creation_key).toBe(first.creation_key);
  });

  it("renames each level through the record that owns its title", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce(reconciled);
    show();
    await screen.findAllByRole("row");
    const rename = async (kind: string, from: string, to: string) => {
      fireEvent.doubleClick(within(rowOf(kind)).getByRole("button", { name: from }));
      const input = within(rowOf(kind)).getByRole("textbox");
      fireEvent.change(input, { target: { value: to } });
      fireEvent.keyDown(input, { key: "Enter" });
    };
    await rename("project", "项目一", "新项目");
    await waitFor(() => expect(apiMock.updateProject).toHaveBeenCalledWith("proj-1", { title: "新项目" }));
    await rename("module", "模块一", "新模块");
    await waitFor(() => expect(apiMock.updateModule).toHaveBeenCalledWith("mod-1", { title: "新模块" }));
    await rename("work_item", "工作项一", "新工作项");
    await waitFor(() => expect(apiMock.updateCockpitNode).toHaveBeenCalledWith("w1", { name: "新工作项" }));
    // The L1/L2 name is a projection: their own node name is never written.
    expect(apiMock.updateCockpitNode).toHaveBeenCalledTimes(1);
  });

  it("opens the new-issue dialog filed into the work item's module", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce(reconciled);
    show();
    await screen.findAllByRole("row");
    const open = vi.spyOn(useModalStore.getState(), "open");
    fireEvent.click(within(rowOf("work_item")).getByRole("button", { name: enCockpit.plan_tree.add_issue }));
    // A work item's own project_id/module_id are null by design (S2.1): the
    // filing comes from the module row above it, and the dialog is told which
    // row it was opened on so the create can carry work_item_id.
    expect(open).toHaveBeenCalledWith("create-issue", {
      project_id: "proj-1",
      module_id: "mod-1",
      cockpit_node: {
        node_id: "w1",
        code: "01.01.01",
        label: "01.01.01 工作项一",
        project_id: "proj-1",
        module_id: "mod-1",
      },
    });
    open.mockRestore();
  });

  it("deletes a work item through the work-item interface after naming its issues", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce(reconciled);
    show();
    await screen.findAllByRole("row");
    fireEvent.click(within(rowOf("work_item")).getByRole("button", { name: enCockpit.plan_tree.more }));
    fireEvent.click(screen.getByRole("menuitem", { name: enCockpit.plan_tree.delete }));
    const confirmBar = screen.getByRole("dialog", { name: enCockpit.plan_tree.delete });
    expect(confirmBar).toHaveTextContent("2");
    fireEvent.click(within(confirmBar).getByRole("button", { name: enCockpit.plan_tree.confirm }));
    await waitFor(() => expect(apiMock.deleteCockpitNode).toHaveBeenCalledWith("w1"));
    expect(apiMock.deleteModule).not.toHaveBeenCalled();
  });

  it("deletes a module through the module interface, after listing what goes with it", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce(reconciled);
    show();
    await screen.findAllByRole("row");
    fireEvent.click(within(rowOf("module")).getByRole("button", { name: enCockpit.plan_tree.more }));
    fireEvent.click(screen.getByRole("menuitem", { name: enCockpit.plan_tree.delete }));
    const dialog = await screen.findByRole("alertdialog");
    // One work item, one payment, two issues on this module.
    expect(dialog).toHaveTextContent("Deletes 1 work items and 1 payments; 2 issues lose their filing and stay in the project.");
    const confirm = await within(dialog).findByRole("button", { name: "Delete module" });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(apiMock.deleteModule).toHaveBeenCalledWith("ws-1", "mod-1"));
    expect(apiMock.deleteCockpitNode).not.toHaveBeenCalled();
  });

  it("moves a work item to the module picked in the menu", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce(reconciled);
    show();
    await screen.findAllByRole("row");
    fireEvent.click(within(rowOf("work_item")).getByRole("button", { name: enCockpit.plan_tree.more }));
    fireEvent.click(screen.getByRole("menuitem", { name: enCockpit.plan_tree.move }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "m2" } });
    await waitFor(() => expect(apiMock.moveCockpitWorkItem).toHaveBeenCalledWith("w1", expect.objectContaining({ parent_id: "m2" })));
  });

  it("shows the issue, workflow and allowed statuses when a move is refused", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce(reconciled);
    apiMock.moveCockpitWorkItem.mockRejectedValueOnce({ status: 400, body: {
      code: "status_not_in_workflow", error: "status not in workflow", issue: "MUL-607",
      workflow_name: "研发流程", allowed_statuses: ["待办", "进行中"],
    } });
    show();
    await screen.findAllByRole("row");
    fireEvent.click(within(rowOf("work_item")).getByRole("button", { name: enCockpit.plan_tree.more }));
    fireEvent.click(screen.getByRole("menuitem", { name: enCockpit.plan_tree.move }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "m2" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("MUL-607");
    expect(screen.getByRole("alert")).toHaveTextContent("研发流程");
    expect(screen.getByRole("alert")).toHaveTextContent("待办 / 进行中");
  });

  it("shows the server's own message when a plan write is refused", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce(reconciled);
    apiMock.moveCockpitWorkItem.mockRejectedValueOnce({ status: 409, body: { error: "目标模块已满，无法移动" } });
    show();
    await screen.findAllByRole("row");
    fireEvent.click(within(rowOf("work_item")).getByRole("button", { name: enCockpit.plan_tree.more }));
    fireEvent.click(screen.getByRole("menuitem", { name: enCockpit.plan_tree.move }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "m2" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("目标模块已满，无法移动");
  });

  it("gives a context-only row no structure controls", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce({ ...reconciled, context_node_ids: ["m1"] });
    show();
    await screen.findAllByRole("row");
    const moduleRow = rowOf("module");
    expect(within(moduleRow).queryByRole("button", { name: enCockpit.plan_tree.add_child })).toBeNull();
    expect(within(moduleRow).queryByRole("button", { name: enCockpit.plan_tree.add_issue })).toBeNull();
    expect(within(moduleRow).queryByRole("button", { name: enCockpit.plan_tree.more })).toBeNull();
    // Its work item is still editable — only the ancestor is context.
    expect(within(rowOf("work_item")).getByRole("button", { name: enCockpit.plan_tree.more })).toBeInTheDocument();
  });

  it("moves a cursor with the arrow keys and hands the row over on Enter", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce(reconciled);
    const opened: string[] = [];
    show({ onSelect: (id) => opened.push(id) });
    const grid = await screen.findByRole("treegrid");
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
    apiMock.getCockpitPlan.mockResolvedValueOnce(reconciled);
    show();
    const grid = await screen.findByRole("treegrid");
    const workItem = () => rowOf("work_item");
    // Put the cursor on the first work item (project → module → work item).
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    await waitFor(() => expect(workItem()).toHaveAttribute("data-active", "true"));
    fireEvent.keyDown(workItem(), { key: "ArrowRight" });
    expect(await screen.findByText(/首个任务/)).toBeInTheDocument();
    fireEvent.keyDown(workItem(), { key: "ArrowLeft" });
    await waitFor(() => expect(workItem()).toHaveAttribute("aria-expanded", "false"));
  });

  it("renders the plan's columns in table mode, with the issue tally", async () => {
    apiMock.getCockpitPlan.mockResolvedValueOnce(reconciled);
    show({ variant: "table", onPatchNode: () => {}, ownerSuggestions: ["李林"] });
    expect(await screen.findByRole("columnheader", { name: enCockpit.plan_tree.column_owner })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: enCockpit.plan_tree.column_dates })).toBeInTheDocument();
    const workItem = rowOf("work_item");
    // 2 primary, 0 reference — the same tally the gantt and the finance grid quote.
    expect(within(workItem).getByText("2 primary · 0 reference")).toBeInTheDocument();
  });
});
