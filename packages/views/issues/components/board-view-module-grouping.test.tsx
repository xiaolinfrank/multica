/**
 * @vitest-environment jsdom
 *
 * Board grouped by module, inside a project. A module holds a level of the
 * project's hierarchy whether or not any card is filed under it, so the server
 * lists the empty ones too — this file is what catches a board that renders
 * only the modules that happen to hold work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import { getIssueSurfaceViewStore } from "@multica/core/issues/stores/surface-view-store";
import type { Issue, Module } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { IssueContextMenuProvider } from "../actions/issue-actions-context-menu";
import type { IssueGroupBranches } from "../surface/use-issue-group-branches";
import { BoardView } from "./board-view";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@multica/core/properties", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/properties")>()),
  propertyListOptions: () => ({
    queryKey: ["properties"],
    queryFn: async () => [],
  }),
  useSetIssueProperty: () => ({ mutate: () => {} }),
  useUnsetIssueProperty: () => ({ mutate: () => {} }),
}));

vi.mock("@multica/core/workspace/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/workspace/hooks")>()),
  useActorName: () => ({ getActorName: () => "Someone" }),
}));

vi.mock("@multica/core/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/auth")>()),
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: "viewer-1" } }),
}));

vi.mock("@multica/core/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/agents")>()),
  isAgentRuntimeBound: () => true,
  useAgentPresenceDetail: () => ({ availability: "offline", workload: null }),
}));

vi.mock("@multica/core/paths", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@multica/core/paths")>();
  return {
    ...actual,
    useCurrentWorkspace: () => ({ id: "ws-1", slug: "acme" }),
    useWorkspacePaths: () => actual.paths.workspace("acme"),
  };
});

vi.mock("../../navigation", () => ({
  AppLink: ({ children, ...props }: React.ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
  useNavigation: () => ({
    push: () => {},
    openInNewTab: () => {},
    getShareableUrl: (path: string) => `https://app.example${path}`,
    pathname: "/",
  }),
  resolveClickIntent: () => "push",
  useIntentNavigate: () => () => {},
}));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const WORKED_MOD_ID = "33333333-3333-4333-8333-333333333333";
const EMPTY_MOD_ID = "55555555-5555-4555-8555-555555555555";

function makeModule(id: string, title: string): Module {
  return {
    id,
    workspace_id: "ws-1",
    project_id: PROJECT_ID,
    title,
    description: null,
    position: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    issue_count: 0,
    done_count: 0,
  };
}

function makeIssue(id: string, moduleId: string | null): Issue {
  return {
    id,
    workspace_id: "ws-1",
    number: 1,
    identifier: `MUL-${id}`,
    title: `Task ${id}`,
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

const ISSUES = [makeIssue("worked", WORKED_MOD_ID)];

const DESCRIPTORS = [
  {
    key: `module:${WORKED_MOD_ID}`,
    value: { kind: "module" as const, module_id: WORKED_MOD_ID },
    count: 1,
  },
  {
    key: `module:${EMPTY_MOD_ID}`,
    value: { kind: "module" as const, module_id: EMPTY_MOD_ID },
    count: 0,
  },
];

/** What `useIssueGroupBranches` hands the board for `{ kind: "module" }`. */
function makeGroupBranches(
  descriptors: IssueGroupBranches["descriptors"],
  issues: Issue[],
): IssueGroupBranches {
  return {
    enabled: true,
    descriptors,
    issues,
    pagination: {},
    total: issues.length,
    isLoading: false,
    isRefreshing: false,
    isError: false,
    hasMoreGroups: false,
    isLoadingMoreGroups: false,
    loadMoreGroups: () => {},
    retryGroups: () => {},
  };
}

class ObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

describe("Board grouped by module", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", ObserverStub);
    vi.stubGlobal("ResizeObserver", ObserverStub);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function render(onCreateIssue: (defaults: unknown) => void = () => {}) {
    const store = getIssueSurfaceViewStore(
      `board-module-${Math.floor(Math.random() * 1e9)}`,
    );
    store.getState().setGrouping("module");
    renderWithI18n(
      <QueryClientProvider client={queryClient}>
        <ViewStoreProvider store={store}>
          <IssueContextMenuProvider>
            <BoardView
              issues={ISSUES}
              visibleStatuses={["todo"]}
              hiddenStatuses={[]}
              onMoveIssue={() => {}}
              moduleMap={
                new Map([
                  [WORKED_MOD_ID, makeModule(WORKED_MOD_ID, "Parser rewrite")],
                  [EMPTY_MOD_ID, makeModule(EMPTY_MOD_ID, "Zero work")],
                ])
              }
              projectId={PROJECT_ID}
              onCreateIssue={onCreateIssue}
              groupBranches={makeGroupBranches(DESCRIPTORS, ISSUES)}
            />
          </IssueContextMenuProvider>
        </ViewStoreProvider>
      </QueryClientProvider>,
    );
  }

  it("gives a module with no cards a column of its own", () => {
    render();

    expect(screen.getByText("Parser rewrite")).toBeTruthy();
    const empty = screen.getByText("Zero work").parentElement!;
    expect(empty.textContent).toContain("0");
  });

  it("files a card created from an empty column under that module", () => {
    const onCreateIssue = vi.fn();
    render(onCreateIssue);

    const column = screen.getByText("Zero work").closest("div.flex-col")!;
    fireEvent.click(within(column as HTMLElement).getByRole("button", { name: "Add issue" }));
    expect(onCreateIssue).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      module_id: EMPTY_MOD_ID,
    });
  });
});
