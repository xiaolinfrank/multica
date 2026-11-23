/**
 * @vitest-environment jsdom
 *
 * Table grouped by work item, and the work-item column. The server hands back
 * only a work-item id per group; the header text is resolved on the client
 * from the plan read — a header that renders the raw uuid, or a cell that
 * loses the "code name" address, is the failure this file catches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setApiInstance } from "@multica/core/api";
import { issueOperationPageFixture } from "../operation-basis-test-fixture";
import type { ApiClient } from "@multica/core/api/client";
import { useModalStore } from "@multica/core/modals";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import { getIssueSurfaceViewStore } from "@multica/core/issues/stores/surface-view-store";
import type {
  Issue,
  IssueBatchReceipt,
  IssueTableGroupsRequest,
  IssueTableQuerySpec,
  IssueTableRowsRequest,
} from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { IssueSurfaceSelectionProvider } from "../surface/selection-context";
import type { IssueSurfaceSelection } from "../surface/selection-context";
import { IssueSurfaceActionsProvider } from "../surface/actions-context";
import { TableView } from "./table-view";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: {
    count: number;
    getItemKey?: (index: number) => unknown;
  }) => ({
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: options.getItemKey?.(index) ?? index,
        start: index * 41,
        end: (index + 1) * 41,
        size: 41,
        lane: 0,
      })),
    getTotalSize: () => options.count * 41,
    measureElement: () => {},
  }),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: () => "Someone" }),
  buildActorNameResolver: () => () => "Someone",
}));

const authState = { user: { id: "user-1", email: "t@t.co", name: "Tester" }, isAuthenticated: true };
vi.mock("@multica/core/auth", () => ({
  useAuthStore: Object.assign(
    (selector?: (state: unknown) => unknown) =>
      selector ? selector(authState) : authState,
    { getState: () => authState },
  ),
}));

vi.mock("../../navigation", () => ({
  AppLink: ({ children, ...props }: React.ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
  useNavigation: () => ({
    push: () => {},
    openInNewTab: () => {},
    getShareableUrl: (path: string) => "https://app.example" + path,
    pathname: "/",
  }),
  resolveClickIntent: () => "push",
  useIntentNavigate: () => () => {},
}));

vi.mock("@multica/core/paths", async () => {
  const actual =
    await vi.importActual<typeof import("@multica/core/paths")>(
      "@multica/core/paths",
    );
  return { ...actual, useWorkspacePaths: () => actual.paths.workspace("test") };
});

class ObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

class VisibleIntersectionObserver {
  #callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.#callback = callback;
  }
  observe(target: Element) {
    setTimeout(() => {
      this.#callback(
        [{ isIntersecting: true, target } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    }, 0);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const WORK_ITEM_ID = "66666666-6666-4666-8666-666666666666";

function makeIssue(id: string, workItemId: string | null): Issue {
  return {
    id,
    workspace_id: "ws-1",
    number: 1,
    identifier: "MUL-" + id,
    title: "Task " + id,
    description: null,
    status: "todo",
    priority: "none",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "member-1",
    parent_issue_id: null,
    project_id: PROJECT_ID,
    module_id: "33333333-3333-4333-8333-333333333333",
    work_item_id: workItemId,
    position: 1,
    stage: null,
    start_date: null,
    due_date: null,
    labels: [],
    metadata: {},
    properties: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  } as unknown as Issue;
}

/** The plan read the table resolves work-item names through: one project,
 *  two work items, only one of which holds an issue. */
const plan = {
  cockpit: { id: "cp", title: "Programme", plan_reconciled_at: "2026-11-20T00:00:00Z", goal_date: null },
  nodes: [
    { id: "p1", code: "01", name: "Programme", kind: "project", position: 0, project_id: PROJECT_ID, parent_id: null },
    { id: "m1", code: "01.02", name: "Docking", kind: "module", parent_id: "p1", position: 0, module_id: "33333333-3333-4333-8333-333333333333", project_id: PROJECT_ID },
    { id: WORK_ITEM_ID, code: "01.02.01", name: "Interface draft", kind: "work_item", parent_id: "m1", position: 0 },
    { id: "w2", code: "01.02.02", name: "Pilot build", kind: "work_item", parent_id: "m1", position: 1 },
  ],
  task_counts: [],
  context_node_ids: [],
  payments: [],
  milestones: [],
  node_index: [],
  meetings: [],
  meeting_issues: [],
  meeting_nodes: [],
  issue_links: [],
};

/** The plan fixture wrapped as the surface the client validates: scope
 *  echoed, `complete`, and counts that agree with the arrays. */
function planPage(scope: { projectId: string | null; moduleId: string | null }) {
  return {
    workspace_id: "ws-1",
    scope: {
      project_id: scope.projectId,
      module_id: scope.moduleId,
      project_title: "Programme",
      module_title: scope.moduleId ? "Docking" : "",
    },
    cockpit: plan.cockpit,
    actor: { user_id: "user-1", role: "owner", is_human: true },
    has_meeting_workflows: false,
    has_stable_bindings: false,
    complete: true,
    nodes: plan.nodes,
    task_counts: plan.task_counts,
    context_node_ids: plan.context_node_ids,
    payments: plan.payments,
    milestones: plan.milestones,
    node_index: plan.node_index,
    counts: {
      nodes: plan.nodes.length,
      payments: plan.payments.length,
      milestones: plan.milestones.length,
      index_nodes: plan.node_index.length,
    },
  };
}

const PROJECT_ROW = {
  id: PROJECT_ID,
  workspace_id: "ws-1",
  title: "Programme",
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

const MODULE_ROW = {
  id: "33333333-3333-4333-8333-333333333333",
  workspace_id: "ws-1",
  project_id: PROJECT_ID,
  title: "Docking",
  description: null,
  position: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  issue_count: 1,
  done_count: 0,
};

const ROWS_BY_GROUP: Record<string, Issue[]> = {
  "work_item:none": [makeIssue("loose", null)],
  ["work_item:" + WORK_ITEM_ID]: [makeIssue("filed", WORK_ITEM_ID)],
};

const projectQuery: IssueTableQuerySpec = {
  scope: { kind: "project", project_id: PROJECT_ID },
  filters: {},
  sort: { field: "position", direction: "asc" },
};

const selection: IssueSurfaceSelection = {
  selectedIds: new Set<string>(),
  toggle: () => {},
  select: () => {},
  deselect: () => {},
  clear: () => {},
};

const noReceipt: IssueBatchReceipt = {
  workspace_id: "ws-1",
  requested_ids: [],
  transaction_mode: "per_item",
  transaction_outcome: "not_started",
  results: [],
  unconfirmed_ids: [],
};

describe("Table grouped by work item", () => {
  let queryClient: QueryClient;
  let groupRequests: IssueTableGroupsRequest[];
  let rowRequests: IssueTableRowsRequest[];
  let surfaceKey: string;

  beforeEach(() => {
    groupRequests = [];
    rowRequests = [];
    surfaceKey = "work-item-grouping-" + Math.floor(Math.random() * 1e9);
    vi.stubGlobal("IntersectionObserver", VisibleIntersectionObserver);
    vi.stubGlobal("ResizeObserver", ObserverStub);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    setApiInstance({
      getIssueOperationBasis: async (wsId: string, ids: string[]) => issueOperationPageFixture(wsId, ids),
      listProperties: async () => ({ properties: [] }),
      listMembers: async () => [],
      listAgents: async () => [],
      listSquads: async () => [],
      getAssigneeFrequency: async () => [],
      listIssueStatuses: async () => ({ statuses: [] }),
      listProjects: async () => ({ projects: [PROJECT_ROW], total: 1 }),
      listModules: async () => ({ modules: [MODULE_ROW], total: 1 }),
      // The plan read is answered with the read's own scope echoed back: the
      // client refuses a surface whose scope does not match what it asked.
      getCockpitPlan: async (_ws: string, scope: { projectId: string | null; moduleId: string | null }) => planPage(scope),
      listIssueTableGroups: async (request: IssueTableGroupsRequest) => {
        groupRequests.push(request);
        return {
          query_fingerprint: "test",
          total: 2,
          groups: [
            { key: "work_item:none", value: { kind: "work_item", work_item_id: null }, count: 1 },
            { key: "work_item:" + WORK_ITEM_ID, value: { kind: "work_item", work_item_id: WORK_ITEM_ID }, count: 1 },
          ],
          next_cursor: null,
        };
      },
      listIssueTableRows: async (request: IssueTableRowsRequest) => {
        rowRequests.push(request);
        // Grouped requests name their group; an ungrouped request (the column
        // tests) gets the unfiled row, which is the one with an empty cell.
        const rows = ROWS_BY_GROUP[request.group_key ?? ""] ?? (request.group_key == null ? [makeIssue("loose", null)] : []);
        return {
          query_fingerprint: "test",
          group_key: request.group_key ?? null,
          parent_id: request.parent_id ?? null,
          total: rows.length,
          rows: rows.map((issue) => ({ issue, direct_child_count: 0 })),
          branch_total: rows.length,
          next_cursor: null,
        };
      },
    } as unknown as ApiClient);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function render(
    columns: "grouped" | "column" = "grouped",
    options: {
      withWorkItemColumn?: boolean;
      updateIssue?: (id: string, updates: Record<string, unknown>) => void;
      exportIssues?: () => Promise<Issue[]>;
    } = {},
  ) {
    const store = getIssueSurfaceViewStore(surfaceKey);
    store.getState().setTableGrouping(columns === "grouped" ? "work_item" : "none");
    if (columns === "column" || options.withWorkItemColumn) store.getState().toggleTableColumn("work_item");
    renderWithI18n(
      <QueryClientProvider client={queryClient}>
        <ViewStoreProvider store={store}>
          <IssueSurfaceSelectionProvider selection={selection}>
            <IssueSurfaceActionsProvider
              actions={{
                isPending: false,
                createIssue: () => {},
                updateIssue: options.updateIssue ?? (() => {}),
                moveIssue: () => {},
                batchUpdate: async () => noReceipt,
                batchDelete: async () => noReceipt,
              }}
            >
            <TableView
              serverQuery={projectQuery}
              childProgressMap={new Map()}
              search=""
              onSearchChange={() => {}}
              onLoadedIssuesChange={() => {}}
              onCreateIssue={() => {}}
              exportIssues={options.exportIssues ?? (() => Promise.resolve([]))}
              resolveExportLookups={() =>
                Promise.resolve({
                  projectMap: new Map(),
                  childProgressMap: new Map(),
                })
              }
            />
            </IssueSurfaceActionsProvider>
          </IssueSurfaceSelectionProvider>
        </ViewStoreProvider>
      </QueryClientProvider>,
    );
  }

  it("asks the server for work-item groups", async () => {
    render();
    await waitFor(() => expect(groupRequests).not.toHaveLength(0));
    expect(groupRequests[0]?.group).toEqual({ kind: "work_item" });
  });

  it("labels each group with the work item's code and name, and the empty one as no work item", async () => {
    render();
    // Both headers wait on the plan read that names them.
    expect(await screen.findByText("01.02.01 Interface draft")).toBeTruthy();
    expect(screen.getByText("No work item")).toBeTruthy();
    // Never the id.
    expect(screen.queryByText(WORK_ITEM_ID)).toBeNull();
  });

  it("shows a work item's code and name in its column cell", async () => {
    // The column rides the grouped table so the cell is asserted on a row the
    // same fixture also names in a header.
    render("grouped", { withWorkItemColumn: true });
    await screen.findByText("01.02.01 Interface draft");
    // Both groups load their first page on mount (work-item groups open), so
    // the row this test reads is on screen without a fold interaction.
    await waitFor(() => expect(rowRequests.length).toBe(2));
    await waitFor(() => expect(rowRequests.some((request) => request.group_key === "work_item:" + WORK_ITEM_ID)).toBe(true));
    await waitFor(() => {
      // Once for the group header, once for the row's own cell: a table that
      // names the work item only in its header has no column.
      expect(screen.getAllByText("01.02.01 Interface draft")).toHaveLength(2);
    });
    expect(screen.queryByText(WORK_ITEM_ID)).toBeNull();
  });

  it("writes only the work item when the cell picks another one", async () => {
    const updateIssue = vi.fn();
    render("column", { updateIssue });
    const cell = await screen.findByRole("button", { name: "No work item" });
    fireEvent.click(cell);
    // The popover reopens on the row's filing (project and module already
    // expanded — the row has a module), so the work item is one click away.
    fireEvent.click(await screen.findByRole("button", { name: "01.02.01 Interface draft" }));

    // A work item names its module and project, so the write names the work
    // item alone — the server derives the rest.
    // A work item names its module and project, so the write names the work
    // item alone — the server derives the rest.
    expect(updateIssue).toHaveBeenCalledTimes(1);
    expect(updateIssue.mock.calls[0]?.[0]).toBe("loose");
    expect(updateIssue.mock.calls[0]?.[1]).toEqual({ work_item_id: WORK_ITEM_ID });
  });

  it("confirms the detach when a sub-issue's cell picks another work item", async () => {
    const child = { ...makeIssue("child", WORK_ITEM_ID), parent_issue_id: "parent-1" } as Issue;
    setApiInstance({
      getIssueOperationBasis: async (wsId: string, ids: string[]) => issueOperationPageFixture(wsId, ids),
      listProperties: async () => ({ properties: [] }),
      listMembers: async () => [],
      listAgents: async () => [],
      listSquads: async () => [],
      getAssigneeFrequency: async () => [],
      listIssueStatuses: async () => ({ statuses: [] }),
      listProjects: async () => ({ projects: [PROJECT_ROW], total: 1 }),
      listModules: async () => ({ modules: [MODULE_ROW], total: 1 }),
      getCockpitPlan: async () => plan,
      listIssueTableGroups: async () => ({
        query_fingerprint: "test", total: 1, groups: [], next_cursor: null,
      }),
      listIssueTableRows: async () => ({
        query_fingerprint: "test", group_key: null, parent_id: null, total: 1,
        rows: [{ issue: child, direct_child_count: 0 }], branch_total: 1, next_cursor: null,
      }),
    } as unknown as ApiClient);
    const updateIssue = vi.fn();
    useModalStore.getState().close();
    render("column", { updateIssue });
    await screen.findByText("Task child");

    const cell = await screen.findByRole("button", { name: "01.02.01 Interface draft" });
    fireEvent.click(cell);
    // The row is already filed: the popover reopens with project and module
    // both expanded, so the sibling work item is one click away.
    fireEvent.click(await screen.findByRole("button", { name: "01.02.02 Pilot build" }));

    // A sub-issue stays in its parent's work item; the one way through is the
    // dialog that detaches in the same write — not a silent write the server
    // refuses.
    expect(useModalStore.getState().modal).toBe("issue-module-detach-confirm");
    expect(useModalStore.getState().data).toMatchObject({
      issueId: "child",
      updates: { work_item_id: "w2" },
    });
    expect(updateIssue).not.toHaveBeenCalled();
    useModalStore.getState().close();
  });

  it("exports the work-item column as code and name", async () => {
    const filed = makeIssue("filed", WORK_ITEM_ID);
    const loose = makeIssue("loose", null);
    // The column test reads one row; the export reads every row through its
    // own callback, so the table shows the unfiled one and the CSV gets both.
    setApiInstance({
      getIssueOperationBasis: async (wsId: string, ids: string[]) => issueOperationPageFixture(wsId, ids),
      listProperties: async () => ({ properties: [] }),
      listMembers: async () => [],
      listAgents: async () => [],
      listSquads: async () => [],
      getAssigneeFrequency: async () => [],
      listIssueStatuses: async () => ({ statuses: [] }),
      listProjects: async () => ({ projects: [PROJECT_ROW], total: 1 }),
      listModules: async () => ({ modules: [MODULE_ROW], total: 1 }),
      getCockpitPlan: async (_ws: string, scope: { projectId: string | null; moduleId: string | null }) => planPage(scope),
      listIssueTableRows: async () => ({
        query_fingerprint: "test", group_key: null, parent_id: null, total: 1,
        rows: [{ issue: filed, direct_child_count: 0 }], branch_total: 1, next_cursor: null,
      }),
    } as unknown as ApiClient);
    // The export builds a Blob and hands it to an anchor; capture the Blob
    // itself and read it back, rather than guessing at the download.
    let exported: Blob | null = null;
    const createObjectURL = vi.fn((blob: Blob) => {
      exported = blob;
      return "blob:csv";
    });
    const revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const originalURL = globalThis.URL;
    vi.stubGlobal("URL", Object.assign(originalURL, { createObjectURL, revokeObjectURL }));
    let csv = "";
    try {
      render("column", { exportIssues: () => Promise.resolve([filed, loose]) });
      await screen.findByText("Task filed");
      // The loose row's empty cell must export empty, never the uuid.
      expect(loose.work_item_id).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /Export/ }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Export all" }));

      await waitFor(() => expect(click).toHaveBeenCalled());
      expect(exported).toBeInstanceOf(Blob);
      csv = await (exported as Blob | null as Blob).text();
      // Header, then the filed row's "code name" and the unfiled row's empty
      // cell — the same address the column shows.
      expect(csv).toContain("01.02.01 Interface draft");
      expect(csv).not.toContain(WORK_ITEM_ID);
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
