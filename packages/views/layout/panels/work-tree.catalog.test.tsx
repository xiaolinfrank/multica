import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import { projectSidebarSource } from "@multica/core/issues/sidebar-list";
import { useSidebarKeptStore } from "@multica/core/issues/stores/sidebar-kept-store";
import { useSidebarTreeStore } from "@multica/core/issues/stores/sidebar-tree-store";
import type { Project } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { ProjectsSection } from "./work-tree";

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => <>{children}</>,
  PointerSensor: vi.fn(),
  closestCenter: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(),
}));
vi.mock("@multica/ui/components/common/tooltip-hint", () => ({
  TooltipHint: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@multica/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/paths")>();
  return { ...actual, useWorkspacePaths: () => actual.paths.workspace("acme") };
});

const adapter: NavigationAdapter = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/acme/issues",
  searchParams: new URLSearchParams(),
  hash: "",
  getShareableUrl: (path) => path,
};

const TODO_STATUS = {
  id: "s-todo",
  workspace_id: "ws-1",
  key: "todo",
  name: "Todo",
  description: "",
  category: "unstarted",
  color: "",
  is_system: true,
  position: 0,
  archived_at: null,
  created_at: "",
  updated_at: "",
};

const PROJECT = { id: "p1", title: "Desktop", status: "in_progress", issue_count: 4, done_count: 1 } as Project;

let listIssues: ReturnType<typeof vi.fn>;
let listIssueStatuses: ReturnType<typeof vi.fn>;

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithI18n(
    <QueryClientProvider client={qc}>
      <NavigationProvider value={adapter}>
        <ProjectsSection
          wsId="ws-1"
          pathname="/acme/issues"
          projects={[PROJECT]}
          totalProjects={1}
          plainRowsLit
        />
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listIssues = vi.fn(async () => ({ issues: [], total: 0 }));
  listIssueStatuses = vi.fn(async () => ({ statuses: [TODO_STATUS], categories: [], total: 1 }));
  setApiInstance({
    listIssues,
    listIssueStatuses,
    getIssueViewPreference: vi.fn(() => new Promise(() => {})),
    // The plan read the tree makes now: reconciled, one module, no work items.
    getCockpitPlan: vi.fn(async () => ({
      workspace_id: "ws-1",
      scope: { project_id: "p1", module_id: null, project_title: "Desktop", module_title: "" },
      cockpit: { id: "cp", workspace_id: "ws-1", title: "Desktop", goal_date: null, plan_reconciled_at: "2026-11-20T00:00:00Z" },
      actor: { user_id: "u1", role: "owner", is_human: true },
      has_meeting_workflows: false,
      has_stable_bindings: false,
      complete: true,
      nodes: [
        { id: "row-a", code: "01", name: "Parser", kind: "module", parent_id: null, position: 0, module_id: "mod-1", project_id: "p1" },
      ],
      task_counts: [], context_node_ids: [], payments: [], milestones: [], node_index: [],
    })),
    getCockpitNodeDetail: vi.fn(async () => null),
  } as unknown as ApiClient);
  useSidebarKeptStore.setState({ held: {} });
  useSidebarTreeStore.setState({ projectsCollapsed: false, expanded: [projectSidebarSource("p1")] });
});

describe("ProjectsSection project row", () => {
  // The project row no longer lists issues — modules and work items took
  // over (S6 batch 3), so the status-catalog retry the old list offered has
  // no reader here anymore. What stays observable is the row itself: it
  // renders, and expanding it reads the plan, not the issue list.
  it("expands a project into its plan without the status catalog", async () => {
    renderSection();

    const toggle = screen.getByRole("button", { name: "Show or hide Desktop's modules and work items" });
    // The store is seeded with this project expanded; one click collapses it.
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    await screen.findByText("No module");
    expect(listIssues).not.toHaveBeenCalled();
  });
});
