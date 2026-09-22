/**
 * @vitest-environment jsdom
 *
 * Table grouped by module. Like project grouping, the server hands back only
 * a module id per group, so the header text the user reads is resolved on the
 * client — a group row that renders the raw uuid is the failure this file
 * exists to catch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import { getIssueSurfaceViewStore } from "@multica/core/issues/stores/surface-view-store";
import type {
  Issue,
  IssueTableGroupsRequest,
  IssueTableGroupsResponse,
  IssueTableQuerySpec,
  IssueTableRowsRequest,
} from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { IssueSurfaceSelectionProvider } from "../surface/selection-context";
import type { IssueSurfaceSelection } from "../surface/selection-context";
import { TableView } from "./table-view";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

// jsdom has no layout, so the real row virtualizer sees a 0-height viewport and
// renders nothing. Render every row inline instead.
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
const MOD_ID = "33333333-3333-4333-8333-333333333333";
/** A module the modules query does not answer for — deleted, or invisible
 *  to this member. Its rows still exist, so its header still has to say
 *  something. */
const GHOST_MOD_ID = "44444444-4444-4444-8444-444444444444";

function makeIssue(id: string, moduleId: string | null): Issue {
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
    module_id: moduleId,
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
    issue_count: 1,
    done_count: 0,
  };
}

const ROWS_BY_GROUP: Record<string, Issue[]> = {
  "module:none": [makeIssue("loose", null)],
  ["module:" + MOD_ID]: [makeIssue("filed", MOD_ID)],
  ["module:" + GHOST_MOD_ID]: [makeIssue("ghost", GHOST_MOD_ID)],
};

const serverQuery: IssueTableQuerySpec = {
  scope: { kind: "workspace" },
  filters: {},
  sort: { field: "position", direction: "asc" },
};

/** The project page's query: this is what turns the module catalog on. */
const projectQuery: IssueTableQuerySpec = {
  scope: { kind: "project", project_id: PROJECT_ID },
  filters: {},
  sort: { field: "position", direction: "asc" },
};

/** A module of this project that nothing is filed under yet. */
const EMPTY_MOD_ID = "55555555-5555-4555-8555-555555555555";

const selection: IssueSurfaceSelection = {
  selectedIds: new Set<string>(),
  toggle: () => {},
  select: () => {},
  deselect: () => {},
  clear: () => {},
};

describe("Table grouped by module", () => {
  let queryClient: QueryClient;
  let groupRequests: IssueTableGroupsRequest[];
  let rowRequests: IssueTableRowsRequest[];
  let moduleCatalog: ReturnType<typeof makeModule>[];
  let groupsByQuery: IssueTableGroupsResponse["groups"];
  let surfaceKey: string;

  beforeEach(() => {
    groupRequests = [];
    rowRequests = [];
    moduleCatalog = [makeModule(MOD_ID, "Parser rewrite", 0)];
    groupsByQuery = [
      // No-module first, then by title — the server's own group order.
      { key: "module:none", value: { kind: "module", module_id: null }, count: 1 },
      {
        key: "module:" + MOD_ID,
        value: { kind: "module", module_id: MOD_ID },
        count: 1,
      },
      {
        key: "module:" + GHOST_MOD_ID,
        value: { kind: "module", module_id: GHOST_MOD_ID },
        count: 1,
      },
    ];
    surfaceKey = "module-grouping-" + Math.floor(Math.random() * 1e9);
    vi.stubGlobal("IntersectionObserver", VisibleIntersectionObserver);
    vi.stubGlobal("ResizeObserver", ObserverStub);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    setApiInstance({
      listProperties: async () => ({ properties: [] }),
      listMembers: async () => [],
      listAgents: async () => [],
      listSquads: async () => [],
      getAssigneeFrequency: async () => [],
      listIssueStatuses: async () => ({ statuses: [] }),
      listProjects: async () => ({ projects: [], total: 0 }),
      listModules: async () => ({
        modules: moduleCatalog,
        total: moduleCatalog.length,
      }),
      listIssueTableGroups: async (request: IssueTableGroupsRequest) => {
        groupRequests.push(request);
        return {
          query_fingerprint: "test",
          total: 3,
          groups: groupsByQuery,
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
    query: IssueTableQuerySpec = serverQuery,
    onCreateIssue: (defaults: Record<string, unknown>) => void = () => {},
  ) {
    const store = getIssueSurfaceViewStore(surfaceKey);
    store.getState().setTableGrouping("module");
    renderWithI18n(
      <QueryClientProvider client={queryClient}>
        <ViewStoreProvider store={store}>
          <IssueSurfaceSelectionProvider selection={selection}>
            <TableView
              serverQuery={query}
              childProgressMap={new Map()}
              search=""
              onSearchChange={() => {}}
              onLoadedIssuesChange={() => {}}
              onCreateIssue={onCreateIssue}
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

  it("asks the server for module groups", async () => {
    render();
    await waitFor(() => expect(groupRequests).not.toHaveLength(0));
    expect(groupRequests[0]?.group).toEqual({ kind: "module" });
  });

  /** Module groups render folded, so a test about ROWS opens its group first. */
  async function openGroup(label: RegExp) {
    const header = await screen.findByRole("button", { name: label });
    fireEvent.click(header);
  }

  /** Group headers only exist while the branch catalog is settled, so every
   * assertion about a header runs inside one retried block rather than after
   * a separate await — a header read between two catalog states proves
   * nothing. */
  async function groupHeaders(assert: () => void) {
    await waitFor(() => {
      expect(screen.getByText("Parser rewrite")).toBeTruthy();
      assert();
    });
  }

  it("labels each group with the module title, never its id", async () => {
    render();
    await groupHeaders(() => {
      expect(screen.queryByText(MOD_ID)).toBeNull();
    });
  });

  it("names the no-module group instead of leaving it blank", async () => {
    render();
    await groupHeaders(() => {
      expect(screen.getByText("No module")).toBeTruthy();
    });
  });

  it("reads an unresolvable module as unavailable rather than as its id", async () => {
    render();
    await groupHeaders(() => {
      expect(screen.queryByText(GHOST_MOD_ID)).toBeNull();
      expect(screen.getByText("Unavailable value")).toBeTruthy();
    });
  });

  it("lands each row under its own module group", async () => {
    render();
    await openGroup(/Parser rewrite\s*1/);
    await openGroup(/No module\s*1/);
    await screen.findByText("MUL-filed");
    await screen.findByText("MUL-loose");
  });

  it("groups by the modules that hold work when no project narrows the query", async () => {
    render();
    await waitFor(() => expect(groupRequests).not.toHaveLength(0));
    // Workspace-wide, the catalog would be every module in the workspace.
    expect(groupRequests[0]?.group).toEqual({ kind: "module" });
  });

  describe("inside a project", () => {
    beforeEach(() => {
      moduleCatalog = [
        makeModule(MOD_ID, "Parser rewrite", 0),
        makeModule(EMPTY_MOD_ID, "Zero work", 1),
      ];
      groupsByQuery = [
        { key: "module:none", value: { kind: "module", module_id: null }, count: 1 },
        {
          key: "module:" + MOD_ID,
          value: { kind: "module", module_id: MOD_ID },
          count: 1,
        },
        // What include_empty adds: a module the query matched no issue in.
        {
          key: "module:" + EMPTY_MOD_ID,
          value: { kind: "module", module_id: EMPTY_MOD_ID },
          count: 0,
        },
      ];
    });

    it("asks the server for the project's empty modules too", async () => {
      render(projectQuery);
      await waitFor(() => expect(groupRequests).not.toHaveLength(0));
      expect(groupRequests[0]?.group).toEqual({
        kind: "module",
        include_empty: true,
      });
    });

    it("shows a module with no tasks as its own group, and asks for no rows under it", async () => {
      render(projectQuery);
      await screen.findByText("Zero work");
      // Opened, so the branch would be requested if the group held anything —
      // the server counted it at zero, so there is nothing to ask for.
      await openGroup(/Zero work\s*0/);
      await openGroup(/Parser rewrite\s*1/);
      await screen.findByText("MUL-filed");
      expect(
        rowRequests.some(
          (request) => request.group_key === "module:" + EMPTY_MOD_ID,
        ),
      ).toBe(false);
    });

    it("opens folded, and keeps a module the user opened open", async () => {
      // Every module is listed, so the table reads as an outline until the
      // reader opens one; the choice is persisted per surface by the store.
      const store = getIssueSurfaceViewStore(surfaceKey);
      render(projectQuery);
      await screen.findByText("Parser rewrite");
      expect(screen.queryByText("MUL-filed")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: /Parser rewrite\s*1/ }));
      await screen.findByText("MUL-filed");
      expect(store.getState().tableExpandedGroups).toEqual([
        "module:" + MOD_ID,
      ]);
    });

    it("creates in the module the header stands for", async () => {
      const onCreateIssue = vi.fn();
      render(projectQuery, onCreateIssue);
      await screen.findByText("Zero work");
      fireEvent.click(
        screen.getByRole("button", { name: "Add issue to Zero work" }),
      );
      expect(onCreateIssue).toHaveBeenCalledWith({
        project_id: PROJECT_ID,
        module_id: EMPTY_MOD_ID,
      });
    });
  });
});
