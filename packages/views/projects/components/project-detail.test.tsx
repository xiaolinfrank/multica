import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project } from "@multica/core/types";
import { useModalStore } from "@multica/core/modals";
import { useCreateModeStore } from "@multica/core/issues/stores";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { ProjectDetail } from "./project-detail";

const mocks = vi.hoisted(() => ({
  role: "admin",
  modules: { current: [] as Array<Record<string, unknown>> },
  issueSurface: { current: null as Record<string, unknown> | null },
  copyText: vi.fn(),
  deleteProject: vi.fn(),
  getShareableUrl: vi.fn((path: string) => `https://app.example${path}`),
  push: vi.fn(),
  recordVisit: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@multica/ui/lib/clipboard", () => ({
  copyText: mocks.copyText,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: readonly unknown[] }) => {
    switch (options.queryKey?.[0]) {
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
      default:
        return { data: undefined, isLoading: false };
    }
  },
}));

vi.mock("@multica/core/projects/queries", () => ({
  projectDetailOptions: () => ({ queryKey: ["project-detail"] }),
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
  useUpdateProject: () => ({ mutate: vi.fn() }),
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
  Sheet: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SheetContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
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
  IssueSurface: (props: Record<string, unknown>) => {
    mocks.issueSurface.current = props;
    return null;
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
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-01T00:00:00Z",
  issue_count: 3,
  done_count: 1,
  resource_count: 0,
};

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

  renderWithI18n(
    <NavigationProvider value={adapter}>
      <ProjectDetail projectId={PROJECT.id} />
    </NavigationProvider>,
  );
}

beforeEach(() => {
  mocks.role = "admin";
  mocks.copyText.mockReset().mockResolvedValue(true);
  mocks.deleteProject.mockReset();
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

  it("does not offer project deletion to regular members", () => {
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

  it("navigates with the module param when a module chip is picked", async () => {
    const user = userEvent.setup();
    renderProjectDetail();

    await user.click(
      screen.getByRole("button", { name: /parser rewrite/i }),
    );

    expect(mocks.push).toHaveBeenCalledWith(
      "/test-workspace/projects/project-1?module=module-1",
    );
  });

  it("navigates with the none param from the ungrouped chip", async () => {
    const user = userEvent.setup();
    renderProjectDetail();

    await user.click(screen.getByRole("button", { name: "No module" }));

    expect(mocks.push).toHaveBeenCalledWith(
      "/test-workspace/projects/project-1?module=none",
    );
  });

  it("shows the active module in the breadcrumb and clears back to all", async () => {
    const user = userEvent.setup();
    renderProjectDetail("module=module-1");

    const chip = screen.getByRole("button", { name: /parser rewrite/i });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed"),
    ).toBe("false");

    // The breadcrumb clear affordance drops the param entirely.
    await user.click(screen.getByRole("button", { name: "Clear module" }));
    expect(mocks.push).toHaveBeenCalledWith(
      "/test-workspace/projects/project-1",
    );
  });

  it("resets to all from the All chip, dropping the param", async () => {
    const user = userEvent.setup();
    renderProjectDetail("module=none");

    await user.click(screen.getByRole("button", { name: "All" }));

    expect(mocks.push).toHaveBeenCalledWith(
      "/test-workspace/projects/project-1",
    );
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
