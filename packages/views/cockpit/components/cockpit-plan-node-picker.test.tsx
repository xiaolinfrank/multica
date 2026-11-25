/**
 * @vitest-environment jsdom
 *
 * The meeting link picker: one project's plan at a time, every level
 * selectable. A project row must be clickable before its plan arrives — the
 * click asks for the plan and lands on the row — and only a read plan that
 * names no project row can be reported as missing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import { renderWithI18n } from "../../test/i18n";
import { CockpitPlanNodePicker } from "./cockpit-plan-node-picker";

vi.mock("../../../navigation", () => ({
  AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>,
  useNavigation: () => ({ push: () => {}, searchParams: new URLSearchParams() }),
}));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const MODULE_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ROW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MODULE_ROW_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORK_ITEM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const project = {
  id: PROJECT_ID,
  workspace_id: "ws-1",
  title: "Programme",
  description: null,
  status: "active",
  priority: "medium",
  icon: "📁",
  color: "#2563eb",
  lead_type: null,
  lead_id: null,
  start_date: null,
  due_date: null,
  collab_path: null,
  position: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const modules = [
  {
    id: MODULE_ID,
    workspace_id: "ws-1",
    project_id: PROJECT_ID,
    title: "01.02 Docking",
    description: null,
    position: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    issue_count: 0,
    done_count: 0,
  },
];

function planRows() {
  return [
    {
      id: PROJECT_ROW_ID, code: "01", name: "Programme", kind: "project",
      parent_id: null, position: 0, project_id: PROJECT_ID, module_id: null,
    },
    {
      id: MODULE_ROW_ID, code: "01.02", name: "01.02 Docking", kind: "module",
      parent_id: PROJECT_ROW_ID, position: 0, project_id: PROJECT_ID, module_id: MODULE_ID,
    },
    {
      id: WORK_ITEM_ID, code: "01.02.01", name: "Interface draft", kind: "work_item",
      parent_id: MODULE_ROW_ID, position: 0, project_id: PROJECT_ID, module_id: null,
    },
  ];
}

function planData(nodes = planRows(), reconciled = true) {
  return {
    workspace_id: "ws-1",
    scope: { project_id: PROJECT_ID, module_id: null, project_title: "Programme", module_title: "" },
    cockpit: {
      id: "cp",
      workspace_id: "ws-1",
      goal_date: null,
      plan_reconciled_at: reconciled ? "2026-11-20T00:00:00Z" : null,
    },
    actor: { user_id: "user-1", role: "owner", is_human: true },
    has_meeting_workflows: false,
    has_stable_bindings: false,
    complete: true,
    nodes,
    task_counts: [],
    context_node_ids: [],
    payments: [],
    milestones: [],
    node_index: [],
  };
}

const searchItem = {
  id: WORK_ITEM_ID,
  title: "Interface draft",
  project_id: PROJECT_ID,
  module_id: MODULE_ID,
  code: "01.02.01",
  eligible: false,
  reason: "work_item",
};

describe("CockpitPlanNodePicker", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    setApiInstance({
      listProjects: async () => ({ projects: [project], total: 1 }),
      listModules: async () => ({ modules, total: 1 }),
      getCockpitPlan: async () => planData(),
      searchCockpitScopeNodes: async () => ({
        workspace_id: "ws-1",
        scope: { project_id: null, module_id: null, q: "", eligible: false },
        items: [searchItem],
        total: 1,
        filtered_total: 1,
        next_cursor: null,
      }),
    } as unknown as ApiClient);
  });

  afterEach(() => {
    cleanup();
  });

  function show(onSelect: (nodeId: string) => void | Promise<unknown>, opts: { scope?: { projectId: string | null; moduleId: string | null } } = {}) {
    renderWithI18n(
      <QueryClientProvider client={queryClient}>
        <CockpitPlanNodePicker
          wsId="ws-1"
          label="Work item"
          value=""
          onSelect={onSelect}
          scope={opts.scope}
        />
      </QueryClientProvider>,
    );
  }

  const open = () => fireEvent.click(screen.getByRole("button", { name: "Work item" }));

  it("loads the plan when a collapsed project row is clicked and lands on its L1 row", async () => {
    const onSelect = vi.fn();
    show(onSelect);
    open();
    // No expand step: the row itself is the click, and its plan is what it
    // needs. Before the fix this row was disabled while collapsed, so the
    // branch below could never run.
    const row = await screen.findByRole("button", { name: "Programme" });
    expect(row).toBeEnabled();
    fireEvent.click(row);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(PROJECT_ROW_ID));
  });

  it("selects a module row (L2) once the project's plan is open", async () => {
    const onSelect = vi.fn();
    show(onSelect);
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Expand project Programme" }));
    fireEvent.click(await screen.findByRole("button", { name: "01.02 Docking" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(MODULE_ROW_ID));
  });

  it("selects a work item row (L3)", async () => {
    const onSelect = vi.fn();
    show(onSelect);
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Expand project Programme" }));
    fireEvent.click(await screen.findByRole("button", { name: "Expand module 01.02 Docking" }));
    fireEvent.click(await screen.findByRole("button", { name: "01.02.01 Interface draft" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(WORK_ITEM_ID));
  });

  it("reports a project row the read plan does not contain, and only then disables it", async () => {
    setApiInstance({
      listProjects: async () => ({ projects: [project], total: 1 }),
      listModules: async () => ({ modules, total: 1 }),
      getCockpitPlan: async () => planData([]),
    } as unknown as ApiClient);
    const onSelect = vi.fn();
    show(onSelect);
    open();
    const row = await screen.findByRole("button", { name: "Programme" });
    fireEvent.click(row);
    await waitFor(() => expect(row).toBeDisabled());
    expect(row).toHaveAttribute("title", "The project's plan row has not been created yet.");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not file a pending click against a project expanded afterwards", async () => {
    // A row click waits for that project's plan. If the reader then opens a
    // different project, the wait must be cancelled: the next plan to arrive
    // is not the one that was clicked.
    const BETA_ID = "66666666-6666-4666-8666-666666666666";
    setApiInstance({
      listProjects: async () => ({ projects: [project, { ...project, id: BETA_ID, title: "Beta" }], total: 2 }),
      listModules: async () => ({ modules, total: 1 }),
      getCockpitPlan: async (_wsId: string, scope: { projectId: string | null }) =>
        scope.projectId === BETA_ID
          ? planData([
              {
                id: "beta-row", code: "02", name: "Beta", kind: "project",
                parent_id: null, position: 0, project_id: BETA_ID, module_id: null,
              },
            ])
          : planData([]),
    } as unknown as ApiClient);
    const onSelect = vi.fn();
    show(onSelect);
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Programme" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Programme" })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Expand project Beta" }));
    expect(await screen.findByText("This project has no modules yet.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Beta" })).toBeEnabled());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("reports a module row the plan does not contain without selecting anything", async () => {
    setApiInstance({
      listProjects: async () => ({ projects: [project], total: 1 }),
      listModules: async () => ({ modules, total: 1 }),
      getCockpitPlan: async () =>
        planData(planRows().filter((node) => node.kind !== "module")),
    } as unknown as ApiClient);
    const onSelect = vi.fn();
    show(onSelect);
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Expand project Programme" }));
    const moduleRow = await screen.findByRole("button", { name: "01.02 Docking" });
    expect(moduleRow).toHaveAttribute("title", "The module's plan row has not been created yet.");
    fireEvent.click(moduleRow);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("says the plan failed and retries the read", async () => {
    let reads = 0;
    setApiInstance({
      listProjects: async () => ({ projects: [project], total: 1 }),
      listModules: async () => ({ modules, total: 1 }),
      getCockpitPlan: async () => {
        reads += 1;
        throw new Error("403");
      },
    } as unknown as ApiClient);
    show(vi.fn());
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Expand project Programme" }));
    expect(await screen.findByText("The plan could not be read.")).toBeInTheDocument();
    const before = reads;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(reads).toBeGreaterThan(before));
  });

  it("falls back to search on an unreconciled board instead of calling the row missing", async () => {
    setApiInstance({
      listProjects: async () => ({ projects: [project], total: 1 }),
      listModules: async () => ({ modules, total: 1 }),
      getCockpitPlan: async () => planData(planRows(), false),
      searchCockpitScopeNodes: async () => ({
        workspace_id: "ws-1",
        scope: { project_id: null, module_id: null, q: "01.02", eligible: false },
        items: [searchItem],
        total: 1,
        filtered_total: 1,
        next_cursor: null,
      }),
    } as unknown as ApiClient);
    const onSelect = vi.fn();
    show(onSelect);
    open();
    const row = await screen.findByRole("button", { name: "Programme" });
    fireEvent.click(row);
    expect(
      await screen.findByText("This board's plan has not been reconciled, so the three-level tree cannot be shown."),
    ).toBeInTheDocument();
    expect(screen.getByText("Search by code or name to choose a row instead.")).toBeInTheDocument();
    expect(row).toBeEnabled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("searches the workspace and appends the next page", async () => {
    const searches: Array<Record<string, unknown>> = [];
    setApiInstance({
      listProjects: async () => ({ projects: [project], total: 1 }),
      listModules: async () => ({ modules, total: 1 }),
      getCockpitPlan: async () => planData(),
      searchCockpitScopeNodes: async (_wsId: string, query: Record<string, unknown>) => {
        searches.push(query);
        return {
          workspace_id: "ws-1",
          scope: { project_id: null, module_id: null, q: String(query.q ?? ""), eligible: false },
          items: query.cursor
            ? [{ ...searchItem, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", code: "01.02.02", title: "Cohort handover" }]
            : [searchItem],
          total: 2,
          filtered_total: 2,
          next_cursor: query.cursor ? null : "page-2",
        };
      },
    } as unknown as ApiClient);
    const onSelect = vi.fn();
    show(onSelect);
    open();
    fireEvent.change(screen.getByRole("textbox", { name: "Search by code or name…" }), {
      target: { value: "01.02" },
    });
    expect(await screen.findByRole("button", { name: /01\.02\.01 Interface draft/ })).toBeInTheDocument();
    expect(searches.at(-1)).toMatchObject({ q: "01.02" });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("button", { name: /01\.02\.02 Cohort handover/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /01\.02\.01 Interface draft/ })).toBeInTheDocument();
  });

  it("keeps the popover open and names the reason when the selection cannot be saved", async () => {
    const onSelect = vi.fn().mockRejectedValue(new Error("the link could not be saved"));
    show(onSelect);
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Expand project Programme" }));
    fireEvent.click(await screen.findByRole("button", { name: "01.02 Docking" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("the link could not be saved");
    // The tree is still there to try another row.
    expect(screen.getByRole("textbox", { name: "Search by code or name…" })).toBeInTheDocument();
  });

  it("displays plan codes on projects and modules when titles are stripped of prefixes", async () => {
    setApiInstance({
      listProjects: async () => ({
        projects: [{ ...project, code: "01", title: "高质量数据集" }],
        total: 1,
      }),
      listModules: async () => ({
        modules: [{ ...modules[0], code: "01.01", title: "回顾性队列" }],
        total: 1,
      }),
      getCockpitPlan: async () =>
        planData([
          {
            id: PROJECT_ROW_ID, code: "01", name: "高质量数据集", kind: "project",
            parent_id: null, position: 0, project_id: PROJECT_ID, module_id: null,
          },
          {
            id: MODULE_ROW_ID, code: "01.01", name: "回顾性队列", kind: "module",
            parent_id: PROJECT_ROW_ID, position: 0, project_id: PROJECT_ID, module_id: MODULE_ID,
          },
        ]),
    } as unknown as ApiClient);

    show(vi.fn());
    open();
    expect(await screen.findByRole("button", { name: "01 高质量数据集" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Expand project 01 高质量数据集" }));
    expect(await screen.findByRole("button", { name: "01.01 回顾性队列" })).toBeVisible();
  });
});
