/**
 * @vitest-environment jsdom
 *
 * The ownership row's write behavior: which fields a move writes, when the
 * cross-project handoff is confirmed first, and what the confirmed write
 * carries. The picker itself is exercised for real (projects/modules/work
 * items served from the API mock) so the row under test is the row users
 * click.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import type { UpdateIssueRequest } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { IssueScopeProperty } from "./issue-scope-property";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

// The dialog's own rendering is covered by workflows/handoff-confirm-dialog.
// Here it only has to report what the row handed it and fire its confirm.
const dialog = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock("../../workflows/handoff-confirm-dialog", () => ({
  WorkflowHandoffConfirmDialog: (props: Record<string, unknown>) => {
    dialog.last = props;
    if (!props.issue) return null;
    return (
      <div role="dialog" aria-label="handoff">
        <button type="button" onClick={() => (props.onConfirm as (o: { stopPreviousRuns: boolean }) => void)({ stopPreviousRuns: false })}>
          Move to {(props.toProject as { title?: string } | null)?.title}
        </button>
      </div>
    );
  },
}));

vi.mock("../../navigation", () => ({
  AppLink: ({ children, ...props }: React.ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
  useNavigation: () => ({ push: () => {}, searchParams: new URLSearchParams() }),
}));

const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";
const MODULE_A = "33333333-3333-4333-8333-333333333333";
const MODULE_B = "44444444-4444-4444-8444-444444444444";
const WI_A1 = "55555555-5555-4555-8555-555555555555";
const WI_B1 = "66666666-6666-4666-8666-666666666666";

function project(id: string, title: string, workflowId: string | null = null) {
  return {
    // A project names the workflow it uses; the handoff check resolves it here.
    workflow_id: workflowId,
    id,
    workspace_id: "ws-1",
    title,
    description: null,
    status: "active",
    priority: "medium",
    icon: "📁",
    color: null,
    lead_type: null,
    lead_id: null,
    start_date: null,
    due_date: null,
    collab_path: null,
    position: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function moduleRow(id: string, projectId: string, title: string) {
  return {
    id,
    workspace_id: "ws-1",
    project_id: projectId,
    title,
    description: null,
    position: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    issue_count: 0,
    done_count: 0,
  };
}

/** A workflow whose every step hands off to a handler. */
const handingOffWorkflow = {
  id: "wf-b",
  workspace_id: "ws-1",
  name: "Delivery",
  description: "",
  is_default: false,
  owner_id: "user-1",
  steps: [
    {
      status_key: "todo",
      // `id`, not `member_id`: the read schema names the handler target `id`.
      handler: { type: "member", id: "user-2" },
      instructions: "",
    },
  ],
  project_ids: [PROJECT_B],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function planPage(scope: { projectId: string | null; moduleId: string | null }) {
  return {
    workspace_id: "ws-1",
    scope: {
      project_id: scope.projectId,
      module_id: scope.moduleId,
      project_title: "A",
      module_title: scope.moduleId ? "M" : "",
    },
    cockpit: { id: "cp", workspace_id: "ws-1", goal_date: null, plan_reconciled_at: "2026-11-20T00:00:00Z" },
    actor: { user_id: "user-1", role: "owner", is_human: true },
    has_meeting_workflows: false,
    has_stable_bindings: false,
    complete: true,
    nodes: [
      { id: "m-row-a", code: "01", name: "Module A", kind: "module", parent_id: null, position: 0, project_id: PROJECT_A, module_id: MODULE_A },
      { id: "m-row-b", code: "02", name: "Module B", kind: "module", parent_id: null, position: 0, project_id: PROJECT_B, module_id: MODULE_B },
      { id: WI_A1, code: "01.01", name: "Draft", kind: "work_item", parent_id: "m-row-a", position: 0 },
      { id: WI_B1, code: "02.01", name: "Build", kind: "work_item", parent_id: "m-row-b", position: 0 },
    ],
    task_counts: [],
    context_node_ids: [],
    payments: [],
    milestones: [],
    node_index: [],
    counts: { nodes: 4, payments: 0, milestones: 0, index_nodes: 0 },
  };
}

const issueFiledInA: {
  id: string;
  identifier: string;
  status: string;
  project_id: string | null;
  module_id: string | null;
  work_item_id: string | null;
} = {
  id: "issue-1",
  identifier: "MUL-1",
  status: "todo",
  project_id: PROJECT_A,
  module_id: MODULE_A,
  work_item_id: WI_A1,
};

let queryClient: QueryClient;
let onUpdate: ReturnType<typeof vi.fn<(updates: Partial<UpdateIssueRequest>) => void>>;

function installApi(handoffWorkflow: boolean) {
  setApiInstance({
    listProjects: async () => ({
      projects: [project(PROJECT_A, "Alpha"), project(PROJECT_B, "Beta", "wf-b")],
      total: 2,
    }),
    listModules: async () => ({
      modules: [moduleRow(MODULE_A, PROJECT_A, "Module A"), moduleRow(MODULE_B, PROJECT_B, "Module B")],
      total: 2,
    }),
    listIssueWorkflows: async () => ({
      workflows: handoffWorkflow ? [handingOffWorkflow] : [],
      total: handoffWorkflow ? 1 : 0,
    }),
    getCockpitPlan: async (_ws: string, scope: { projectId: string | null; moduleId: string | null }) => planPage(scope),
    // The trigger names the selected work item from its node row.
    getCockpitNodeDetail: async (_ws: string, nodeId: string) => {
      if (nodeId === WI_A1) {
        return {
          workspace_id: "ws-1",
          scope: { project_id: null, module_id: null, project_title: "", module_title: "" },
          cockpit: null,
          actor: { user_id: "user-1", role: "owner", is_human: true },
          has_meeting_workflows: false,
          has_stable_bindings: false,
          node: { id: WI_A1, code: "01.01", name: "Draft", kind: "work_item", parent_id: "m-row-a", position: 0 },
          ancestors: [],
          children_count: 0,
          scope_match: true,
          binding: { project_id: PROJECT_A, module_id: MODULE_A, source_node_id: null, eligible: true, reason: "" },
          node_index: [],
          payments: { items: [], total: 0, next_cursor: null },
          payment_total: 0,
          meetings: { items: [], total: 0, next_cursor: null },
        };
      }
      return null;
    },
  } as unknown as ApiClient);
}

function show(issue: typeof issueFiledInA, opts: { readOnly?: boolean } = {}) {
  renderWithI18n(
    <QueryClientProvider client={queryClient}>
      <IssueScopeProperty issue={issue} onUpdate={onUpdate} readOnly={opts.readOnly} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  dialog.last = null;
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  onUpdate = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe("IssueScopeProperty", () => {
  it("shows the issue's current work item", async () => {
    installApi(false);
    show(issueFiledInA);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /01\.01 Draft/ })).toBeInTheDocument(),
    );
  });

  it("moves within the project without a handoff confirmation", async () => {
    installApi(false);
    show({ ...issueFiledInA, work_item_id: null });
    // The trigger names the filing once its lookups land; the popover then
    // reopens with project and module already expanded.
    const trigger = await screen.findByRole("button", { name: "Alpha / Module A" });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "01.01 Draft" }));

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]?.[0]).toEqual({ work_item_id: WI_A1 });
  });

  it("confirms before moving into a project whose workflow hands off", async () => {
    const user = userEvent.setup();
    installApi(true);
    show({ ...issueFiledInA, project_id: null, module_id: null, work_item_id: null });
    await user.click(screen.getByRole("button", { name: "Ownership" }));
    await user.click(await screen.findByRole("button", { name: "Toggle project Beta" }));
    await user.click(await screen.findByRole("button", { name: "Toggle module Module B" }));
    await user.click(await screen.findByRole("button", { name: "02.01 Build" }));

    // The dialog is the WorkflowHandoffConfirmDialog: it renders the preview
    // copy. Nothing is written yet.
    expect(onUpdate).not.toHaveBeenCalled();
    // The row handed the dialog the target project; the dialog is the one
    // place the move is agreed to.
    expect(dialog.last?.toProject).toMatchObject({ id: PROJECT_B, title: "Beta" });
    expect(dialog.last?.toStatus).toBe("");
  });

  it("writes the move with enter_workflow_step after the confirmation", async () => {
    const user = userEvent.setup();
    installApi(true);
    show({ ...issueFiledInA, project_id: null, module_id: null, work_item_id: null });
    await user.click(screen.getByRole("button", { name: "Ownership" }));
    await user.click(await screen.findByRole("button", { name: "Toggle project Beta" }));
    await user.click(await screen.findByRole("button", { name: "Toggle module Module B" }));
    await user.click(await screen.findByRole("button", { name: "02.01 Build" }));

    const confirm = await screen.findByRole("button", { name: "Move to Beta" });
    await user.click(confirm);

    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    const patch = onUpdate.mock.calls[0]?.[0] as Record<string, unknown>;
    // The work item alone names the filing; the handoff flags ride the write.
    expect(patch.work_item_id).toBe(WI_B1);
    expect(patch.enter_workflow_step).toBe(true);
  });
});
