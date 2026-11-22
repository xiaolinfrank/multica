/**
 * @vitest-environment jsdom
 *
 * Table grouped by work item, and the work-item column. The server hands back
 * only a work-item id per group; the header text is resolved on the client
 * from the plan read — a header that renders the raw uuid, or a cell that
 * loses the "code name" address, is the failure this file catches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setApiInstance } from "@multica/core/api";
import { issueOperationPageFixture } from "../operation-basis-test-fixture";
import type { ApiClient } from "@multica/core/api/client";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import { getIssueSurfaceViewStore } from "@multica/core/issues/stores/surface-view-store";
import type {
  Issue,
  IssueTableGroupsRequest,
  IssueTableQuerySpec,
  IssueTableRowsRequest,
} from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { IssueSurfaceSelectionProvider } from "../surface/selection-context";
import type { IssueSurfaceSelection } from "../surface/selection-context";
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
      listProjects: async () => ({ projects: [], total: 0 }),
      listModules: async () => ({ modules: [], total: 0 }),
      getCockpitPlan: async () => plan,
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
        const rows = ROWS_BY_GROUP[request.group_key ?? ""] ?? [];
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
    options: { withWorkItemColumn?: boolean } = {},
  ) {
    const store = getIssueSurfaceViewStore(surfaceKey);
    store.getState().setTableGrouping(columns === "grouped" ? "work_item" : "none");
    if (columns === "column" || options.withWorkItemColumn) store.getState().toggleTableColumn("work_item");
    renderWithI18n(
      <QueryClientProvider client={queryClient}>
        <ViewStoreProvider store={store}>
          <IssueSurfaceSelectionProvider selection={selection}>
            <TableView
              serverQuery={projectQuery}
              childProgressMap={new Map()}
              search=""
              onSearchChange={() => {}}
              onLoadedIssuesChange={() => {}}
              onCreateIssue={() => {}}
              exportIssues={() => Promise.resolve([])}
              resolveExportLookups={() =>
                Promise.resolve({
                  projectMap: new Map(),
                  childProgressMap: new Map(),
                })
              }
            />
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
});
