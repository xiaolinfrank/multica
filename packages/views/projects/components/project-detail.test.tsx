import { containerOperationFixture } from "../../issues/container-operation-test-fixture";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project } from "@multica/core/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useModalStore } from "@multica/core/modals";
import { useCreateModeStore } from "@multica/core/issues/stores";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { ProjectDetail } from "./project-detail";
import { PlanTree } from "../../plan-tree/plan-tree";

const mocks = vi.hoisted(() => ({
  role: "admin",
  operationBlocked: false,
  modules: { current: [] as Array<Record<string, unknown>> },
  plan: { current: null as Record<string, unknown> | null },
  planError: false,
  issueSurface: { current: null as Record<string, unknown> | null },
  copyText: vi.fn(),
  deleteProject: vi.fn(),
  updateProject: vi.fn(),
  getShareableUrl: vi.fn((path: string) => `https://app.example${path}`),
  push: vi.fn(),
  recordVisit: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@multica/ui/lib/clipboard", () => ({
  copyText: mocks.copyText,
}));

vi.mock("../../workflows/project-workflow-menu", () => ({
  ProjectWorkflowMenuHost: ({ children }: { children: (submenu: null) => React.ReactNode }) => children(null),
}));
vi.mock("../../workflows/project-workflow-row", () => ({ ProjectWorkflowControl: () => null }));

vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: (options: { queryKey?: readonly unknown[] }) => {
    switch (options.queryKey?.[0]) {
      case "issue-operation-basis": return { data: containerOperationFixture(String(options.queryKey[1]), "project", String(options.queryKey[4]), mocks.operationBlocked ? { delete: { state: "blocked", reason_codes: ["retained_artifact_scope"] } } : {}), isPending: false, isError: false, refetch: vi.fn() };
      case "project-detail":
        return { data: PROJECT, isLoading: false };
      case "members":
        return {
          data: [{ user_id: "user-1", name: "User One", role: mocks.role }],
          isLoading: false,
        };
      case "agents":
      case "pins":
        return { data: [], isLoading: false };
      case "modules":
        return { data: mocks.modules.current, isLoading: false, isSuccess: true };
      case "cockpit":
        // The left column's plan read (S6). The client throws on an
        // unconfirmed answer, so "no plan" is an error, never a successful
        // empty read — the fixture follows the same rule.
        if (mocks.planError) {
          return { data: undefined, isLoading: false, isError: true, isSuccess: false };
        }
        return mocks.plan.current
          ? { data: mocks.plan.current, isLoading: false, isSuccess: true, isError: false }
          : { data: undefined, isLoading: false, isError: true, isSuccess: false };
      default:
        return { data: undefined, isLoading: false };
    }
  },
}));

vi.mock("@multica/core/projects/queries", () => ({
  projectDetailOptions: () => ({ queryKey: ["project-detail"] }),
  // The plan tree composes delivery paths from the project's collaboration
  // root; these cases are about rows, not folders, so the list is empty.
  projectListOptions: () => ({ queryKey: ["projects-list"], queryFn: async () => [] }),
}));

vi.mock("@multica/core/modules/queries", () => ({
  moduleListOptions: () => ({ queryKey: ["modules"] }),
}));

vi.mock("@multica/core/modules/mutations", () => ({
  useCreateModule: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useUpdateModule: () => ({ mutate: vi.fn() }),
  useDeleteModule: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useReorderModules: () => ({ mutate: vi.fn() }),
}));

vi.mock("@multica/core/projects/mutations", () => ({
  useUpdateProject: () => ({ mutate: mocks.updateProject }),
  useDeleteProject: () => ({ mutate: mocks.deleteProject }),
}));

vi.mock("@multica/core/pins", () => ({
  pinListOptions: () => ({ queryKey: ["pins"] }),
  useCreatePin: () => ({ mutate: vi.fn() }),
  useDeletePin: () => ({ mutate: vi.fn() }),
}));

vi.mock("@multica/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"] }),
  agentListOptions: () => ({ queryKey: ["agents"] }),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

vi.mock("@multica/core/auth", () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: "user-1" } }),
}));

vi.mock("@multica/core/chat", () => ({
  useRecentContextStore: (
    selector: (state: { recordVisit: typeof mocks.recordVisit }) => unknown,
  ) => selector({ recordVisit: mocks.recordVisit }),
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    projects: () => "/test-workspace/projects",
    projectDetail: (id: string) => "/test-workspace/projects/" + id,
  }),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: () => "User One" }),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess },
}));

vi.mock("react-resizable-panels", () => ({
  useDefaultLayout: () => ({
    defaultLayout: undefined,
    onLayoutChanged: vi.fn(),
  }),
  usePanelRef: () => ({
    current: {
      isCollapsed: () => false,
      expand: vi.fn(),
      collapse: vi.fn(),
    },
  }),
}));

vi.mock("@multica/ui/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("@multica/ui/components/common/emoji-picker", () => ({
  EmojiPicker: () => null,
}));

vi.mock("@multica/ui/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => null,
}));

vi.mock("@multica/ui/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

vi.mock("@multica/ui/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@multica/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@multica/ui/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open?: boolean; children: React.ReactNode }) =>
    open ? <>{children}</> : null,
  SheetContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@multica/ui/components/ui/alert-dialog", () => ({
  AlertDialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <div role="alertdialog">{children}</div> : null),
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("../../editor", () => ({
  TitleEditor: ({ defaultValue }: { defaultValue: string }) => (
    <div>{defaultValue}</div>
  ),
  ContentEditor: () => null,
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: () => null,
}));

vi.mock("../../issues/components/priority-icon", () => ({
  PriorityIcon: () => null,
}));

vi.mock("./project-resources-section", () => ({
  ProjectResourcesSection: () => null,
}));

vi.mock("./project-start-date-picker", () => ({
  ProjectStartDatePicker: () => null,
}));

vi.mock("./project-due-date-picker", () => ({
  ProjectDueDatePicker: () => null,
}));

vi.mock("../../issues/surface/issue-surface", () => ({
  // Records the props this fork's module tests assert on, and renders the
  // upstream header slot so header assertions still see the page chrome.
  IssueSurface: ({
    renderHeader,
    ...props
  }: {
    renderHeader?: (ctx: { controller: unknown }) => React.ReactNode;
  } & Record<string, unknown>) => {
    mocks.issueSurface.current = props;
    return <>{renderHeader?.({ controller: {} })}</>;
  },
}));

vi.mock("../../layout/breadcrumb-header", () => ({
  BreadcrumbHeader: ({
    actions,
    leaf,
  }: {
    actions: React.ReactNode;
    leaf?: React.ReactNode;
  }) => (
    <header>
      {leaf}
      {actions}
    </header>
  ),
}));

vi.mock("../../issue-views/view-header", () => ({
  IssueViewHeader: ({
    baseMenu,
    trailing,
  }: {
    baseMenu?: React.ReactNode;
    trailing?: React.ReactNode;
  }) => (
    <header>
      {baseMenu}
      {trailing}
    </header>
  ),
}));

vi.mock("../../layout/animated-right-sidebar", () => ({
  AnimatedRightSidebar: ({ children }: { children: React.ReactNode }) => (
    <aside>{children}</aside>
  ),
  getAnimatedRightSidebarInitialOpen: () => true,
  rightSidebarPanelMotionProps: {},
  useRightSidebarShortcut: vi.fn(),
  useAnimatedRightSidebarState: () => ({
    open: true,
    visualOpen: true,
    motionEnabled: false,
    beginToggle: vi.fn(),
    handleResize: vi.fn(),
  }),
}));

const PROJECT_PATH = "/Volumes/人机协作空间/AI医药联合创新平台";

const PROJECT: Project = {
  id: "project-1",
  workspace_id: "workspace-1",
  title: "Launch Plan",
  description: null,
  icon: null,
  status: "in_progress",
  priority: "high",
  lead_type: null,
  lead_id: null,
  start_date: null,
  due_date: null,
  collab_path: null,
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-01T00:00:00Z",
  issue_count: 3,
  done_count: 1,
  resource_count: 0,
};

// The plan tree's own mutations read the query client, so the page renders
// inside one even though this file answers every `useQuery` from fixtures.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function withNav(adapter: NavigationAdapter) {
  return (
    <QueryClientProvider client={queryClient}>
      <NavigationProvider value={adapter}>
        <ProjectDetail projectId={PROJECT.id} />
      </NavigationProvider>
    </QueryClientProvider>
  );
}

function renderProjectDetail(search = "") {
  const adapter: NavigationAdapter = {
    push: mocks.push,
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/test-workspace/projects/project-1",
    searchParams: new URLSearchParams(search),
    hash: "",
    getShareableUrl: mocks.getShareableUrl,
  };

  renderWithI18n(withNav(adapter));
  return adapter;
}

beforeEach(() => {
  mocks.role = "admin";
  mocks.operationBlocked = false;
  mocks.plan.current = null;
  mocks.planError = false;
  mocks.copyText.mockReset().mockResolvedValue(true);
  mocks.deleteProject.mockReset();
  mocks.updateProject.mockReset();
  mocks.getShareableUrl.mockClear();
  mocks.push.mockReset();
  mocks.recordVisit.mockReset();
  mocks.toastSuccess.mockReset();
  useModalStore.getState().close();
});

describe("ProjectDetail sharing", () => {
  it("copies the platform shareable URL instead of the renderer URL", async () => {
    const user = userEvent.setup();
    renderProjectDetail();

    await user.click(screen.getByRole("button", { name: "Copy link" }));

    expect(mocks.getShareableUrl).toHaveBeenCalledWith(
      "/test-workspace/projects/project-1",
    );
    expect(mocks.copyText).toHaveBeenCalledWith(
      "https://app.example/test-workspace/projects/project-1",
    );
  });
});

describe("ProjectDetail project deletion", () => {
  it("requires confirmation and navigates only after deletion succeeds", async () => {
    const user = userEvent.setup();
    renderProjectDetail();

    await user.click(screen.getByRole("button", { name: "Delete project" }));

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(mocks.deleteProject).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(mocks.deleteProject).toHaveBeenCalledWith(
      PROJECT.id,
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(mocks.push).not.toHaveBeenCalled();

    const options = mocks.deleteProject.mock.calls[0]?.[1] as {
      onSuccess: () => void;
    };
    options.onSuccess();

    expect(mocks.toastSuccess).toHaveBeenCalledWith("Project deleted");
    expect(mocks.push).toHaveBeenCalledWith("/test-workspace/projects");
  });

  it("offers deletion to the project creator", () => {
    mocks.role = "member";
    PROJECT.creator_type = "member";
    PROJECT.creator_id = "user-1";
    try {
      renderProjectDetail();
      expect(screen.getByRole("button", { name: "Delete project" })).toBeInTheDocument();
    } finally {
      delete PROJECT.creator_type;
      delete PROJECT.creator_id;
    }
  });

  it("does not offer project deletion to regular members with an unknown creator", () => {
    mocks.role = "member";

    renderProjectDetail();

    expect(
      screen.queryByRole("button", { name: "Delete project" }),
    ).not.toBeInTheDocument();
  });
});

describe("ProjectDetail issue creation", () => {
  it("opens the create-issue flow seeded with this project", async () => {
    const user = userEvent.setup();
    renderProjectDetail();

    await user.click(screen.getByRole("button", { name: "New Issue" }));

    // Default create-mode preference is "agent", so the quick modal opens.
    expect(useModalStore.getState().modal).toBe("quick-create-issue");
    expect(useModalStore.getState().data).toMatchObject({
      project_id: PROJECT.id,
    });
  });

  it("honours the user's manual create-mode preference", async () => {
    useCreateModeStore.getState().setLastMode("manual");
    const user = userEvent.setup();
    renderProjectDetail();

    await user.click(screen.getByRole("button", { name: "New Issue" }));

    expect(useModalStore.getState().modal).toBe("create-issue");
    expect(useModalStore.getState().data).toMatchObject({
      project_id: PROJECT.id,
    });
    useCreateModeStore.getState().setLastMode("agent");
  });
});

describe("ProjectDetail module filtering", () => {
  beforeEach(() => {
    mocks.modules.current = [
      {
        id: "module-1",
        workspace_id: "workspace-1",
        project_id: PROJECT.id,
        title: "Parser rewrite",
        description: null,
        position: 0,
        created_at: "2026-06-01T00:00:00Z",
        updated_at: "2026-06-01T00:00:00Z",
        issue_count: 3,
        done_count: 1,
      },
    ];
  });

  it("shows the active module in the breadcrumb and clears back to all", async () => {
    const user = userEvent.setup();
    renderProjectDetail("module=module-1");

    // The header chip is the "you are inside this folder" affordance now that
    // the module strip is gone; the left column also lists the module, so the
    // assertion reads the chip itself.
    const clear = screen.getByRole("button", { name: "Clear module" });
    expect(clear.parentElement).toHaveTextContent("Parser rewrite");

    await user.click(clear);
    expect(mocks.push).toHaveBeenCalledWith(
      "/test-workspace/projects/project-1",
    );
  });

  it("defaults the table grouping to module when the project has modules", () => {
    renderProjectDetail();

    expect(mocks.issueSurface.current?.defaultTableGrouping).toBe("module");
  });

  it("defaults the table grouping to none without modules", () => {
    mocks.modules.current = [];

    renderProjectDetail();

    expect(mocks.issueSurface.current?.defaultTableGrouping).toBe("none");
  });

  it("offers module management to workspace admins from the header menu", async () => {
    const user = userEvent.setup();
    renderProjectDetail();

    await user.click(screen.getByRole("button", { name: "Manage modules" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByText("Parser rewrite")).toBeInTheDocument();
  });

  // The inline rename covers the one-field case; description and the
  // collaboration space have no other surface, so the row hands them to the
  // module's own modal and closes itself (one overlay at a time).
  it("opens the module property editor from the manage dialog", async () => {
    const user = userEvent.setup();
    renderProjectDetail();

    await user.click(screen.getByRole("button", { name: "Manage modules" }));
    await user.click(screen.getByRole("button", { name: "Edit module" }));

    expect(useModalStore.getState().modal).toBe("edit-module");
    expect(useModalStore.getState().data).toEqual({ moduleId: "module-1" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the inline rename on the row alongside the property editor", async () => {
    const user = userEvent.setup();
    renderProjectDetail();

    await user.click(screen.getByRole("button", { name: "Manage modules" }));
    await user.click(screen.getByRole("button", { name: "Rename module" }));

    expect(screen.getByRole("textbox", { name: "Rename module" })).toHaveValue(
      "Parser rewrite",
    );
    expect(useModalStore.getState().modal).toBeNull();
  });

  it("hides module management from regular members", () => {
    mocks.role = "member";

    renderProjectDetail();

    expect(
      screen.queryByRole("button", { name: "Manage modules" }),
    ).not.toBeInTheDocument();
  });

  it("narrows the surface and seeds creation for a live module param", () => {
    renderProjectDetail("module=module-1");

    expect(mocks.issueSurface.current?.moduleFilter).toEqual({
      module_ids: ["module-1"],
    });
    expect(mocks.issueSurface.current?.createDefaults).toEqual({
      module_id: "module-1",
    });
  });

  it("narrows to the no-module bucket for the none sentinel", () => {
    renderProjectDetail("module=none");

    expect(mocks.issueSurface.current?.moduleFilter).toEqual({
      include_no_module: true,
    });
    expect(mocks.issueSurface.current?.createDefaults).toBeUndefined();
  });

  // A module deleted after its URL was shared (or a hand-edited param) must
  // not filter the surface into permanent silence: once the list has loaded,
  // an unknown id reads as "all".
  it("falls back to the unfiltered view when the module param is dead", () => {
    renderProjectDetail("module=deleted-module");

    expect(mocks.issueSurface.current?.moduleFilter).toBeUndefined();
    expect(mocks.issueSurface.current?.createDefaults).toBeUndefined();
  });

  it("seeds the header New issue button with the active module", async () => {
    const user = userEvent.setup();
    renderProjectDetail("module=module-1");

    await user.click(screen.getByRole("button", { name: "New Issue" }));

    expect(useModalStore.getState().data).toMatchObject({
      project_id: PROJECT.id,
      module_id: "module-1",
    });
  });
});


describe("ProjectDetail collaboration space", () => {
  it("offers the project's space as an unset property and writes an absolute path", async () => {
    const user = userEvent.setup();
    renderProjectDetail();

    await user.click(screen.getByRole("button", { name: "Not set" }));
    await user.type(
      screen.getByRole("textbox", { name: "Collaboration space" }),
      `${PROJECT_PATH}{Enter}`,
    );

    expect(mocks.updateProject).toHaveBeenCalledWith({
      id: PROJECT.id,
      collab_path: PROJECT_PATH,
    });
  });

  // A relative path is what the server rejects with a 400; the property keeps
  // it in the editor instead of firing the mutation.
  it("does not write a path the server would reject", async () => {
    const user = userEvent.setup();
    renderProjectDetail();

    await user.click(screen.getByRole("button", { name: "Not set" }));
    await user.type(
      screen.getByRole("textbox", { name: "Collaboration space" }),
      "01高质量数据集{Enter}",
    );

    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  // A module's deliverables use its stable directory_name binding inside this
  // directory, so narrowing the page to one module must not grow a second
  // absolute path for someone to fill in and keep in sync with the first.
  it("keeps one space when the page is filtered to a module", () => {
    mocks.modules.current = [
      {
        id: "module-1",
        workspace_id: "workspace-1",
        project_id: PROJECT.id,
        title: "Parser rewrite",
        description: null,
        position: 0,
        created_at: "2026-06-01T00:00:00Z",
        updated_at: "2026-06-01T00:00:00Z",
        issue_count: 3,
        done_count: 1,
      },
    ];
    renderProjectDetail("module=module-1");

    expect(screen.getAllByText("Collaboration space")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Not set" })).toHaveLength(1);
  });
});

describe("ProjectDetail module creation", () => {
  it.each(["owner", "admin", "member"])("prefills the project from the header for %s", async (role) => {
    mocks.role = role;
    const user = userEvent.setup();
    renderProjectDetail();
    await user.click(screen.getByRole("button", { name: "Create module" }));
    expect(useModalStore.getState().modal).toBe("create-module");
    expect(useModalStore.getState().data).toEqual({ projectId: PROJECT.id });
  });
});

it("shows the retained-project reason and prevents the delete command", async () => {
  mocks.operationBlocked = true; renderProjectDetail(); await userEvent.click(screen.getByRole("button", { name: "Delete project" }));
  expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled(); expect(mocks.deleteProject).not.toHaveBeenCalled();
});

it("does not navigate or close the new context when an old project delete returns after route ABA", async () => {
  const adapter: NavigationAdapter = { push: mocks.push, replace: vi.fn(), back: vi.fn(), pathname: "/test-workspace/projects/project-1", searchParams: new URLSearchParams(), hash: "", getShareableUrl: mocks.getShareableUrl };
  const show = (pathname: string) => <NavigationProvider value={{ ...adapter, pathname }}><ProjectDetail projectId={PROJECT.id} /></NavigationProvider>;
  const view = renderWithI18n(show(adapter.pathname)); const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Delete project" })); await user.click(screen.getByRole("button", { name: "Delete" }));
  const callbacks = mocks.deleteProject.mock.calls[0]![1] as { onSuccess: () => void; onSettled: () => void };
  view.rerender(show("/test-workspace/projects/another-project")); view.rerender(show(adapter.pathname));
  await act(async () => { callbacks.onSuccess(); callbacks.onSettled(); });
  expect(mocks.push).not.toHaveBeenCalled(); expect(mocks.toastSuccess).not.toHaveBeenCalled(); expect(screen.getByRole("alertdialog")).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// S6: the plan column, `?node=` selection, and the degraded module-only tree.

const PLAN = {
  cockpit: { id: "cp", title: "Programme", plan_reconciled_at: "2026-11-20T00:00:00Z", goal_date: null },
  nodes: [
    { id: "plan-project", code: "00", name: "Launch Plan", kind: "project", position: 0, parent_id: null, project_id: PROJECT.id, module_id: null },
    { id: "plan-module", code: "00.01", name: "Parser rewrite", kind: "module", parent_id: "plan-project", position: 0, module_id: "module-1", project_id: PROJECT.id },
    { id: "plan-item", code: "00.01.01", name: "Grammar pass", kind: "work_item", parent_id: "plan-module", position: 0, module_id: null, project_id: null },
    { id: "plan-module-2", code: "00.02", name: "Rollout", kind: "module", parent_id: "plan-project", position: 1, module_id: "module-2", project_id: PROJECT.id },
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

/** Rows of the page's plan column: id, address, and the name the row reads —
 *  the three things "the two views agree" is about. The fixture carries no
 *  issue counts, so the row's text is exactly code + name. */
function planRows() {
  const column = screen.getByRole("complementary", { name: "Plan" });
  return [...column.querySelectorAll<HTMLElement>('[role="row"][data-node-id]')].map((row) => {
    const code = row.querySelector("button[title]")?.textContent?.trim() ?? "";
    return {
      id: row.getAttribute("data-node-id"),
      code,
      name: (row.textContent ?? "").slice(code.length).trim(),
    };
  });
}

describe("ProjectDetail plan column", () => {
  beforeEach(() => {
    mocks.plan.current = structuredClone(PLAN);
    mocks.modules.current = [
      { id: "module-1", workspace_id: "workspace-1", project_id: PROJECT.id, title: "Parser rewrite", description: null, position: 0, created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z", issue_count: 0, done_count: 0 },
      { id: "module-2", workspace_id: "workspace-1", project_id: PROJECT.id, title: "Rollout", description: null, position: 1, created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z", issue_count: 0, done_count: 0 },
    ];
  });

  it("lists the project's plan rows, in plan order, down to the work item", () => {
    renderProjectDetail();
    expect(planRows().map((row) => row.id)).toEqual([
      "plan-project",
      "plan-module",
      "plan-item",
      "plan-module-2",
    ]);
    expect(planRows()[1]).toMatchObject({ code: "00.01", name: "Parser rewrite" });
  });

  it("selects a module row into `?node=` and narrows the surface to it", async () => {
    const user = userEvent.setup();
    renderProjectDetail();
    // The row's address is its select affordance (the same one the cockpit
    // tree uses); the name field is the rename target.
    await user.click(screen.getByRole("button", { name: "Open 00.01" }));
    expect(mocks.push).toHaveBeenCalledWith("/test-workspace/projects/project-1?node=plan-module");
  });

  it("narrows by module when the URL already names that row", () => {
    renderProjectDetail("node=plan-module");
    expect(mocks.issueSurface.current?.moduleFilter).toEqual({ module_ids: ["module-1"] });
    expect(mocks.issueSurface.current?.createDefaults).toEqual({ module_id: "module-1" });
  });

  it("narrows by work item and seeds the create with it", () => {
    renderProjectDetail("node=plan-item");
    expect(mocks.issueSurface.current?.moduleFilter).toEqual({ work_item_ids: ["plan-item"] });
    // One flat seed shape: the agent panel reads the same work item id.
    expect(mocks.issueSurface.current?.createDefaults).toMatchObject({
      project_id: "project-1",
      module_id: "module-1",
      work_item_id: "plan-item",
    });
  });

  it("filters nothing when the project's own row is selected", () => {
    renderProjectDetail("node=plan-project");
    expect(mocks.issueSurface.current?.moduleFilter).toBeUndefined();
  });

  it("pages the table by work item when the plan has any", () => {
    renderProjectDetail();
    expect(mocks.issueSurface.current?.defaultTableGrouping).toBe("work_item");
  });
});

describe("ProjectDetail plan parity with the cockpit", () => {
  it("shows the rows the cockpit's plan tree shows at the same scope", () => {
    mocks.plan.current = structuredClone(PLAN);
    renderProjectDetail();
    // Code, name and order — the three things the two views must agree on.
    const fromPage = planRows();

    const cockpit = renderWithI18n(
      <QueryClientProvider client={queryClient}>
        <PlanTree
          wsId="workspace-1"
          scope={{ projectId: PROJECT.id, moduleId: null }}
          query=""
          readOnly={false}
          selectedId={null}
          onSelect={() => {}}
        />
      </QueryClientProvider>,
    );
    const fromCockpit = [
      ...cockpit.container.querySelectorAll<HTMLElement>('[role="row"][data-node-id]'),
    ].map((row) => ({
      id: row.getAttribute("data-node-id"),
      code: row.querySelector("button[title]")?.textContent?.trim(),
    }));

    expect(fromPage.map((row) => row.id)).toEqual(fromCockpit.map((row) => row.id));
    expect(fromPage.map((row) => row.code)).toEqual(fromCockpit.map((row) => row.code));
    expect(fromPage.map((row) => row.name)).toEqual([
      "Launch Plan",
      "Parser rewrite",
      "Grammar pass",
      "Rollout",
    ]);
  });
});

describe("ProjectDetail option conversion", () => {
  beforeEach(() => {
    mocks.plan.current = structuredClone(PLAN);
  });

  it("rewrites a legacy ?module= to the module's own row without a history entry", () => {
    const replace = vi.fn();
    const adapter: NavigationAdapter = {
      push: mocks.push,
      replace,
      back: vi.fn(),
      pathname: "/test-workspace/projects/project-1",
      searchParams: new URLSearchParams("module=module-1"),
      hash: "",
      getShareableUrl: mocks.getShareableUrl,
    };
    renderWithI18n(withNav(adapter));
    expect(replace).toHaveBeenCalledWith("/test-workspace/projects/project-1?node=plan-module");
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("rewrites ?module=none to ?node=none", () => {
    const replace = vi.fn();
    const adapter: NavigationAdapter = {
      push: mocks.push,
      replace,
      back: vi.fn(),
      pathname: "/test-workspace/projects/project-1",
      searchParams: new URLSearchParams("module=none"),
      hash: "",
      getShareableUrl: mocks.getShareableUrl,
    };
    renderWithI18n(withNav(adapter));
    expect(replace).toHaveBeenCalledWith("/test-workspace/projects/project-1?node=none");
  });

  it("drops a ?node= the plan no longer has, and shows everything", () => {
    const replace = vi.fn();
    const adapter: NavigationAdapter = {
      push: mocks.push,
      replace,
      back: vi.fn(),
      pathname: "/test-workspace/projects/project-1",
      searchParams: new URLSearchParams("node=deleted-node"),
      hash: "",
      getShareableUrl: mocks.getShareableUrl,
    };
    renderWithI18n(withNav(adapter));
    expect(mocks.issueSurface.current?.moduleFilter).toBeUndefined();
    expect(replace).toHaveBeenCalledWith("/test-workspace/projects/project-1");
  });

  it("keeps the unfiled bucket on the tree's own parameter", () => {
    renderProjectDetail("node=none");
    expect(mocks.issueSurface.current?.moduleFilter).toEqual({ include_no_module: true });
  });
});

describe("ProjectDetail before reconciliation", () => {
  it("lists modules only, says why, and still narrows by module", async () => {
    mocks.plan.current = {
      ...structuredClone(PLAN),
      cockpit: { id: "cp", title: "Programme", plan_reconciled_at: null, goal_date: null },
    };
    mocks.modules.current = [
      { id: "module-1", workspace_id: "workspace-1", project_id: PROJECT.id, title: "Parser rewrite", description: null, position: 0, created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z", issue_count: 0, done_count: 0 },
    ];
    const user = userEvent.setup();
    renderProjectDetail();

    // No plan rows: the column is a module list with the reason above it.
    expect(screen.getByRole("status")).toHaveTextContent(/has not been reconciled/);
    expect(screen.queryByText("Grammar pass")).toBeNull();
    expect(mocks.issueSurface.current?.defaultTableGrouping).toBe("module");

    await user.click(within(screen.getByRole("complementary", { name: "Plan" })).getByText("Parser rewrite"));
    expect(mocks.push).toHaveBeenCalledWith("/test-workspace/projects/project-1?module=module-1");
  });

  it("opens the tree over the page on a narrow screen, and closes it on a pick", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      const user = userEvent.setup();
      mocks.plan.current = structuredClone(PLAN);
      renderProjectDetail();

      // No inline column — and no dead button either: the toggle opens a sheet.
      expect(screen.queryByRole("complementary", { name: "Plan" })).toBeNull();
      expect(screen.queryByText("Grammar pass")).toBeNull();
      const toggle = screen.getByRole("button", { name: "Show or hide the plan" });
      expect(toggle).toHaveAttribute("aria-pressed", "false");

      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      await user.click(await screen.findByRole("button", { name: "Open 00.01" }));
      expect(mocks.push).toHaveBeenCalledWith("/test-workspace/projects/project-1?node=plan-module");

      // The pick narrows the surface underneath, so the sheet steps aside.
      expect(screen.queryByText("Grammar pass")).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });

  it("keeps the navigator a name list: no counts, no issue rows to expand", () => {
    mocks.plan.current = {
      ...structuredClone(PLAN),
      task_counts: [{ node_id: "plan-item", primary_total: 3, reference_total: 1, active: 2, done: 1, closed: 0 }],
    };
    renderProjectDetail();

    const workItemRow = screen
      .getByRole("complementary", { name: "Plan" })
      .querySelector<HTMLElement>('[role="row"][data-node-id="plan-item"]')!;
    // A work item in this column is a place to click, not a scoreboard: the
    // counts that squeezed its name out of the 256px column are gone.
    expect(workItemRow).not.toHaveAttribute("aria-expanded");
    expect(workItemRow.textContent).toContain("Grammar pass");
    expect(workItemRow.textContent).not.toMatch(/issue|%/);
  });

  it("falls back to the module list and says the plan cannot be read", () => {
    mocks.planError = true;
    mocks.modules.current = [
      { id: "module-1", workspace_id: "workspace-1", project_id: PROJECT.id, title: "Parser rewrite", description: null, position: 0, created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z", issue_count: 0, done_count: 0 },
    ];
    renderProjectDetail();

    expect(screen.getByRole("status")).toHaveTextContent(/could not be read/);
    expect(screen.getByText("Parser rewrite")).toBeInTheDocument();
    expect(mocks.issueSurface.current?.defaultTableGrouping).toBe("module");
  });

  it("hides the column where it would squeeze the surface", () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      mocks.plan.current = structuredClone(PLAN);
      renderProjectDetail();
      expect(screen.queryByRole("complementary", { name: "Plan" })).toBeNull();
      // The surface is still there — nothing is pushed off-screen instead.
      expect(mocks.issueSurface.current).not.toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });
});
