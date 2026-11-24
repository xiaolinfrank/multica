/**
 * @vitest-environment jsdom
 *
 * The ownership picker: projects → modules → work items, with the selection
 * rules that keep the three fields consistent (a work item implies its module
 * and project; a module or project clears the levels below it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import { renderWithI18n } from "../../../test/i18n";
import { IssueScopePicker, type IssueScopeValue } from "./issue-scope-picker";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("../../../navigation", () => ({
  AppLink: ({ children, ...props }: React.ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
  useNavigation: () => ({ push: () => {}, searchParams: new URLSearchParams() }),
}));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const MODULE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_MODULE_ID = "33333333-3333-4333-8333-333333333333";
const WORK_ITEM_ID = "44444444-4444-4444-8444-444444444444";

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

function makeModule(id: string, title: string, position: number) {
  return {
    id,
    workspace_id: "ws-1",
    project_id: PROJECT_ID,
    title,
    description: null,
    position,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    issue_count: 0,
    done_count: 0,
  };
}

const modules = [makeModule(MODULE_ID, "01.02 Docking", 0), makeModule(OTHER_MODULE_ID, "01.03 Pilot", 1)];

const workItem = {
  id: WORK_ITEM_ID,
  title: "Interface draft",
  project_id: PROJECT_ID,
  module_id: MODULE_ID,
  code: "01.02.01",
  eligible: true,
  reason: "",
};

// The plan read is what lists a module's work items now. Two rows, with the
// ids deliberately in the opposite order to their codes: a list ordered by id
// would read 01.02.02 first.
const SECOND_WORK_ITEM_ID = "00000000-0000-4000-8000-000000000001";

function planData(reconciledPlan = true) {
  return {
    workspace_id: "ws-1",
    scope: { project_id: PROJECT_ID, module_id: MODULE_ID, project_title: "Programme", module_title: "01.02 Docking" },
    cockpit: {
      id: "cp",
      workspace_id: "ws-1",
      goal_date: null,
      plan_reconciled_at: reconciledPlan ? "2026-11-20T00:00:00Z" : null,
    },
    actor: { user_id: "user-1", role: "owner", is_human: true },
    has_meeting_workflows: false,
    has_stable_bindings: false,
    complete: true,
    nodes: [
      { id: MODULE_ID, code: "01.02", name: "01.02 Docking", kind: "module", parent_id: null, position: 0, project_id: PROJECT_ID, module_id: MODULE_ID },
      { id: WORK_ITEM_ID, code: "01.02.01", name: "Interface draft", kind: "work_item", parent_id: MODULE_ID, position: 0, project_id: PROJECT_ID, module_id: null },
      { id: SECOND_WORK_ITEM_ID, code: "01.02.02", name: "Cohort handover", kind: "work_item", parent_id: MODULE_ID, position: 1, project_id: PROJECT_ID, module_id: null },
    ],
    task_counts: [],
    context_node_ids: [],
    payments: [],
    milestones: [],
    node_index: [],
  };
}

describe("IssueScopePicker", () => {
  let queryClient: QueryClient;
  let reconciled: boolean;

  beforeEach(() => {
    reconciled = true;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    setApiInstance({
      listProjects: async () => ({ projects: [project], total: 1 }),
      listModules: async () => ({ modules, total: modules.length }),
      getCockpitContext: async () => ({
        workspace_id: "ws-1",
        scope: { project_id: null, module_id: null, project_title: "", module_title: "" },
        cockpit: {
          id: "cp",
          workspace_id: "ws-1",
          goal_date: null,
          plan_reconciled_at: reconciled ? "2026-11-20T00:00:00Z" : null,
        },
        actor: { user_id: "user-1", role: "owner", is_human: true },
        has_meeting_workflows: false,
        has_stable_bindings: false,
      }),
      getCockpitPlan: async () => planData(reconciled),
      searchCockpitScopeNodes: async (_wsId: string, query: { cursor?: string; q?: string }) => ({
        workspace_id: "ws-1",
        scope: { project_id: null, module_id: null, q: query.q ?? "", eligible: true },
        items: query.cursor
          ? [{ ...workItem, id: SECOND_WORK_ITEM_ID, code: "01.02.02", title: "Cohort handover" }]
          : [workItem],
        total: 2,
        filtered_total: 2,
        next_cursor: query.cursor ? null : "page-2",
      }),
    } as unknown as ApiClient);
  });

  afterEach(() => {
    cleanup();
  });

  function show(
    onUpdate: (next: IssueScopeValue) => void,
    value: IssueScopeValue = { project_id: null, module_id: null, work_item_id: null },
    opts: {
      readOnly?: boolean;
      workItemLabel?: string;
      scopeConstraint?: { projectId?: string | null; moduleId?: string | null };
      allowClear?: boolean;
    } = {},
  ) {
    renderWithI18n(
      <QueryClientProvider client={queryClient}>
        <IssueScopePicker
          wsId="ws-1"
          value={value}
          onUpdate={onUpdate}
          readOnly={opts.readOnly}
          workItemLabel={opts.workItemLabel}
          scopeConstraint={opts.scopeConstraint}
          allowClear={opts.allowClear}
        />
      </QueryClientProvider>,
    );
  }

  it("offers projects first and opens a project's modules", async () => {
    show(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "Ownership" }));
    expect(await screen.findByText("Programme")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Toggle project Programme" }));
    expect(await screen.findByText("01.02 Docking")).toBeTruthy();
  });

  it("keeps the work item as its own segment, with the full path as the tooltip", async () => {
    // jsdom has no layout, so this pins the structure the layout depends on:
    // the project and module are what shorten, the work item is not — one
    // truncated string would always cut the work item off first.
    show(
      vi.fn(),
      { project_id: PROJECT_ID, module_id: MODULE_ID, work_item_id: WORK_ITEM_ID },
      { workItemLabel: "01.02.01 Interface draft" },
    );

    const workItem = screen.getByText("01.02.01 Interface draft");
    // Shrink order, as measured in a browser: the project yields hardest
    // (`shrink-[10000]`), the module next (`shrink-[100]`), both down to
    // `min-w-8`; the work item shrinks last and is the one that ellipsizes.
    // Equal weights would let a short module clip while a long project keeps
    // five pixels it does not need. A `shrink-0` work item overflows the row
    // and the outer clip cuts it with no ellipsis.
    expect(await screen.findByText("Programme")).toHaveClass("min-w-8", "shrink-[10000]", "truncate");
    expect(screen.getByText("01.02 Docking")).toHaveClass("min-w-8", "shrink-[100]", "truncate");
    expect(workItem).toHaveClass("min-w-0", "truncate");
    expect(workItem).not.toHaveClass("shrink-0");
    // The separators are their own elements and keep their whitespace: a flex
    // item trims leading/trailing spaces, so the spaces need `pre`.
    for (const separator of screen.getAllByText((_, node) => node?.textContent === " / ")) {
      expect(separator).toHaveClass("shrink-0", "whitespace-pre");
    }
    expect(
      screen.getByRole("button", {
        name: "Programme / 01.02 Docking / 01.02.01 Interface draft",
      }),
    ).toBeInTheDocument();
    expect(workItem.closest("[title]")).toHaveAttribute(
      "title",
      "Programme / 01.02 Docking / 01.02.01 Interface draft",
    );
  });

  it("reads a module's work items at the module's scope, with its project", async () => {
    const scopes: Array<Record<string, unknown>> = [];
    setApiInstance({
      listProjects: async () => ({ projects: [project], total: 1 }),
      listModules: async () => ({ modules, total: modules.length }),
      getCockpitPlan: async (_wsId: string, scope: Record<string, unknown>) => {
        scopes.push(scope);
        return planData();
      },
      searchCockpitScopeNodes: async () => ({
        workspace_id: "ws-1",
        scope: { project_id: PROJECT_ID, module_id: MODULE_ID, q: "", eligible: true },
        items: [workItem],
        total: 1,
        filtered_total: 1,
        next_cursor: null,
      }),
    } as unknown as ApiClient);

    show(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "Ownership" }));
    fireEvent.click(await screen.findByRole("button", { name: "Toggle project Programme" }));
    fireEvent.click(await screen.findByRole("button", { name: "Toggle module 01.02 Docking" }));

    // A module scope needs its project (the server refuses a module alone),
    // so the plan read carries both.
    await waitFor(() =>
      expect(scopes.at(-1)).toMatchObject({ projectId: PROJECT_ID, moduleId: MODULE_ID }),
    );
    // Plan order, not id order: 01.02.01 comes before 01.02.02 even though
    // their ids sort the other way.
    const rows = await screen.findAllByRole("button", { name: /^01\.02\.0/ });
    expect(rows.map((row) => row.textContent)).toEqual([
      "01.02.01 Interface draft",
      "01.02.02 Cohort handover",
    ]);
  });

  it("lists no work items when the read has no row for the opened module", async () => {
    // A plan read can carry another module's rows. Matching by position would
    // offer that module's work items under this module's name.
    setApiInstance({
      listProjects: async () => ({ projects: [project], total: 1 }),
      listModules: async () => ({ modules, total: modules.length }),
      getCockpitPlan: async () => {
        const other = planData();
        return {
          ...other,
          nodes: other.nodes.map((node) =>
            node.id === MODULE_ID ? { ...node, module_id: "another-module" } : node,
          ),
        };
      },
    } as unknown as ApiClient);

    show(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "Ownership" }));
    fireEvent.click(await screen.findByRole("button", { name: "Toggle project Programme" }));
    fireEvent.click(await screen.findByRole("button", { name: "Toggle module 01.02 Docking" }));

    // The read answered — and answered with another module's rows, so this
    // module's list is empty rather than borrowed.
    expect(await screen.findByText("No work items")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "01.02.01 Interface draft" })).toBeNull();
    expect(screen.queryByRole("button", { name: "01.02.02 Cohort handover" })).toBeNull();
  });

  it("says the plan could not be read, not that the board was never reconciled", async () => {
    setApiInstance({
      listProjects: async () => ({ projects: [project], total: 1 }),
      listModules: async () => ({ modules, total: modules.length }),
      getCockpitPlan: async () => {
        throw new Error("403");
      },
    } as unknown as ApiClient);

    show(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "Ownership" }));
    fireEvent.click(await screen.findByRole("button", { name: "Toggle project Programme" }));
    fireEvent.click(await screen.findByRole("button", { name: "Toggle module 01.02 Docking" }));

    expect(await screen.findByText("The plan could not be read, so work items cannot be picked.")).toBeInTheDocument();
    expect(screen.queryByText(/has not been reconciled/)).toBeNull();
  });

  it("searches across the workspace and grows the list instead of replacing it", async () => {
    const searches: Array<Record<string, unknown>> = [];
    setApiInstance({
      listProjects: async () => ({ projects: [project], total: 1 }),
      listModules: async () => ({ modules, total: modules.length }),
      getCockpitPlan: async () => planData(),
      searchCockpitScopeNodes: async (_wsId: string, query: Record<string, unknown>) => {
        searches.push(query);
        return {
          workspace_id: "ws-1",
          scope: { project_id: null, module_id: null, q: String(query.q ?? ""), eligible: true },
          items: query.cursor
            ? [{ ...workItem, id: SECOND_WORK_ITEM_ID, code: "01.02.02", title: "Cohort handover" }]
            : [workItem],
          total: 2,
          filtered_total: 2,
          next_cursor: query.cursor ? null : "page-2",
        };
      },
    } as unknown as ApiClient);

    show(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "Ownership" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search work items…" }), {
      target: { value: "01.02" },
    });

    expect(await screen.findByRole("button", { name: /01\.02\.01 Interface draft/ })).toBeInTheDocument();
    expect(searches.at(-1)).toMatchObject({ q: "01.02" });

    fireEvent.click(screen.getByRole("button", { name: "More" }));

    // "More" appends: the first page stays on screen and the second lands
    // under it.
    expect(await screen.findByRole("button", { name: /01\.02\.02 Cohort handover/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /01\.02\.01 Interface draft/ })).toBeInTheDocument();
  });

  it("files under a work item by its code and name, carrying its module and project", async () => {
    const onUpdate = vi.fn();
    show(onUpdate);
    fireEvent.click(screen.getByRole("button", { name: "Ownership" }));
    fireEvent.click(await screen.findByRole("button", { name: "Toggle project Programme" }));
    fireEvent.click(await screen.findByRole("button", { name: "Toggle module 01.02 Docking" }));
    const row = await screen.findByRole("button", { name: /01\.02\.01 Interface draft/ });
    fireEvent.click(row);
    // One selection names all three: the issue files under the work item and
    // the server derives its module and project from that row.
    expect(onUpdate).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      module_id: MODULE_ID,
      work_item_id: WORK_ITEM_ID,
    });
  });

  it("clears the work item when a module is picked, and both when a project is", async () => {
    const onUpdate = vi.fn();
    show(onUpdate, { project_id: PROJECT_ID, module_id: MODULE_ID, work_item_id: WORK_ITEM_ID }, { workItemLabel: "01.02.01 Interface draft" });
    fireEvent.click(await screen.findByRole("button", { name: /Programme \/ 01.02 Docking \/ 01.02.01 Interface draft/ }));
    fireEvent.click(await screen.findByRole("button", { name: "01.02 Docking" }));
    expect(onUpdate).toHaveBeenLastCalledWith({
      project_id: PROJECT_ID,
      module_id: MODULE_ID,
      work_item_id: null,
    });

    fireEvent.click(await screen.findByRole("button", { name: /Programme \/ 01.02 Docking/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Programme" }));
    expect(onUpdate).toHaveBeenLastCalledWith({
      project_id: PROJECT_ID,
      module_id: null,
      work_item_id: null,
    });
  });

  it("clears everything through the no-filing row", async () => {
    const onUpdate = vi.fn();
    show(onUpdate, { project_id: PROJECT_ID, module_id: MODULE_ID, work_item_id: WORK_ITEM_ID }, { workItemLabel: "01.02.01 Interface draft" });
    fireEvent.click(await screen.findByRole("button", { name: /Programme \/ 01.02 Docking \/ 01.02.01 Interface draft/ }));
    fireEvent.click(await screen.findByRole("button", { name: "No ownership" }));
    expect(onUpdate).toHaveBeenCalledWith({ project_id: null, module_id: null, work_item_id: null });
  });

  it("still offers projects and modules on an unreconciled board, and says why work items are missing", async () => {
    reconciled = false;
    show(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "Ownership" }));
    fireEvent.click(await screen.findByRole("button", { name: "Toggle project Programme" }));
    expect(await screen.findByText("01.02 Docking")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Toggle module 01.02 Docking" }));
    // The reason replaces the list: an empty list would read as "no work items".
    expect(
      await screen.findByText(/has not been reconciled/),
    ).toBeTruthy();
  });

  it("locks the tree to a scoped module and keeps that module when the project is picked", async () => {
    const onUpdate = vi.fn();
    show(onUpdate, { project_id: null, module_id: null, work_item_id: null },
      { scopeConstraint: { projectId: PROJECT_ID, moduleId: OTHER_MODULE_ID } });
    fireEvent.click(screen.getByRole("button", { name: "Ownership" }));
    // Only the scoped module is offered; its sibling is outside the range.
    expect(await screen.findByText("01.03 Pilot")).toBeTruthy();
    expect(screen.queryByText("01.02 Docking")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Programme" }));
    expect(onUpdate).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      module_id: OTHER_MODULE_ID,
      work_item_id: null,
    });
  });

  it("hides the clear row when the caller requires a filing", async () => {
    show(vi.fn(), { project_id: PROJECT_ID, module_id: null, work_item_id: null }, { allowClear: false });
    fireEvent.click(await screen.findByRole("button", { name: "Programme" }));
    expect(screen.queryByRole("button", { name: "No ownership" })).toBeNull();
  });

  it("keeps a sub-issue's filing locked", async () => {
    const onUpdate = vi.fn();
    show(
      onUpdate,
      { project_id: PROJECT_ID, module_id: MODULE_ID, work_item_id: WORK_ITEM_ID },
      { readOnly: true, workItemLabel: "01.02.01 Interface draft" },
    );
    const trigger = await screen.findByRole("button", { name: /Programme \/ 01.02 Docking \/ 01.02.01 Interface draft/ });
    expect(trigger).toBeDisabled();
    expect(screen.queryByRole("button", { name: "No ownership" })).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
