import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DragEndEvent } from "@dnd-kit/core";
import type { IssueViewPreference } from "@multica/core/api/schemas";
import { issueViewPreferenceOptions } from "@multica/core/issue-views/preferences";
import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import {
  DEFAULT_SIDEBAR_ISSUE_SETTINGS,
  DEFAULT_SIDEBAR_PROJECT_SETTINGS,
  useSidebarTreeStore,
} from "@multica/core/issues/stores/sidebar-tree-store";
import { SIDEBAR_PROJECTS_SCOPE } from "@multica/core/issues/sidebar-project-prefs";
import type { Project } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { ProjectsSection } from "./work-tree";

const apiMock = vi.hoisted(() => ({ putIssueViewPreference: vi.fn() }));

const openCreateIssue = vi.hoisted(() => vi.fn());
vi.mock("@multica/core/issues/stores/create-mode-store", () => ({
  openCreateIssueWithPreference: openCreateIssue,
}));

const dnd = vi.hoisted(() => ({ onDragEnd: undefined as ((event: DragEndEvent) => void) | undefined }));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children, onDragEnd }: { children: ReactNode; onDragEnd: (event: DragEndEvent) => void }) => {
    dnd.onDragEnd = onDragEnd;
    return <>{children}</>;
  },
  PointerSensor: vi.fn(),
  closestCenter: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(),
}));

const nav = vi.hoisted(() => ({ searchParams: null as URLSearchParams | null }));
vi.mock("../../navigation", () => ({
  AppLink: ({
    children,
    href,
    newTabTitle: _newTabTitle,
    ...props
  }: { children: ReactNode; href: string; newTabTitle?: string } & React.ComponentProps<"a">) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  useNavigation: () => ({ searchParams: nav.searchParams, pathname: "/acme/issues", push: vi.fn() }),
}));
vi.mock("@multica/ui/components/common/tooltip-hint", () => ({
  TooltipHint: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@multica/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/paths")>();
  return { ...actual, useWorkspacePaths: () => actual.paths.workspace("acme") };
});

const project = (id: string, title: string): Project =>
  ({ id, title, status: "in_progress", issue_count: 4, done_count: 1 }) as Project;
const PROJECTS = [project("p1", "Desktop"), project("p2", "Mobile"), project("p3", "Web")];

const MODULE_RECORD = {
  id: "mod-record-2",
  workspace_id: "ws-1",
  project_id: "p1",
  title: "Docking",
  description: null,
  position: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  issue_count: 0,
  done_count: 0,
};

/** The project-scoped plan read the tree makes. Ids deliberately sort against
 *  the codes, so a list ordered by anything but the plan reads backwards. */
function planData() {
  return {
    workspace_id: "ws-1",
    scope: { project_id: "p1", module_id: null, project_title: "Desktop", module_title: "" },
    cockpit: { id: "cp", workspace_id: "ws-1", title: "Desktop", goal_date: null, plan_reconciled_at: "2026-11-20T00:00:00Z" },
    actor: { user_id: "u1", role: "owner", is_human: true },
    has_meeting_workflows: false,
    has_stable_bindings: false,
    complete: true,
    nodes: [
      { id: "row-b", code: "01.02", name: "Docking", kind: "module", parent_id: null, position: 1, module_id: "mod-record-2", project_id: "p1" },
      { id: "wi-b1", code: "01.02.02", name: "Cohort handover", kind: "work_item", parent_id: "row-b", position: 1 },
      { id: "wi-b0", code: "01.02.01", name: "Interface draft", kind: "work_item", parent_id: "row-b", position: 0 },
      { id: "row-a", code: "01.01", name: "Parser", kind: "module", parent_id: null, position: 0, module_id: "mod-record-1", project_id: "p1" },
      { id: "wi-a0", code: "01.01.01", name: "Grammar pass", kind: "work_item", parent_id: "row-a", position: 0 },
    ],
    task_counts: [],
    context_node_ids: [],
    payments: [],
    milestones: [],
    node_index: [],
  };
}

const nodeDetail = {
  workspace_id: "ws-1",
  scope: { project_id: null, module_id: null, project_title: "", module_title: "" },
  cockpit: null,
  actor: { user_id: "u1", role: "owner", is_human: true },
  has_meeting_workflows: false,
  has_stable_bindings: false,
  node: null as Record<string, unknown> | null,
  ancestors: [] as Array<Record<string, unknown>>,
  children_count: 0,
  scope_match: true,
  binding: null as Record<string, unknown> | null,
  node_index: [],
  payments: { items: [], total: 0, next_cursor: null },
  payment_total: 0,
  meetings: { items: [], total: 0, next_cursor: null },
};

const savedPrefs = (prefs: Record<string, unknown>): IssueViewPreference => ({
  scope_type: "sidebar_projects",
  scope_id: "u1",
  updated_at: "2026-10-31T00:00:00Z",
  prefs: { hidden: [], order: [], ...prefs },
});

/** API mocks at the client boundary: these are the reads the tree really
 *  makes — the plan (modules + work items), the node detail for `?node=`,
 *  and the module records for the unreconciled fallback. */
function installApi(overrides: Partial<Record<string, unknown>> = {}) {
  // `api` is a proxy over a singleton, so mocking at the client boundary is
  // `setApiInstance` — replacing the `api` export would bypass the proxy.
  setApiInstance({
    putIssueViewPreference: apiMock.putIssueViewPreference,
    getCockpitPlan: vi.fn(async () => planData()),
    getCockpitNodeDetail: vi.fn(async () => nodeDetail),
    listModules: vi.fn(async () => ({ modules: [MODULE_RECORD], total: 1 })),
    listIssues: vi.fn(async () => ({ issues: [], total: 0 })),
    ...overrides,
  } as unknown as ApiClient);
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(
    issueViewPreferenceOptions("ws-1", SIDEBAR_PROJECTS_SCOPE).queryKey,
    savedPrefs({
      projects: { ...DEFAULT_SIDEBAR_PROJECT_SETTINGS, ordering: "name" },
      issues: DEFAULT_SIDEBAR_ISSUE_SETTINGS,
      order: ["p9"],
    }),
  );
  renderWithI18n(
    <QueryClientProvider client={qc}>
      <ProjectsSection
        wsId="ws-1"
        pathname="/acme/issues"
        projects={PROJECTS}
        totalProjects={4}
        plainRowsLit
      />
    </QueryClientProvider>,
  );
}

const expandDesktop = () =>
  fireEvent.click(screen.getByRole("button", { name: "Show or hide Desktop's modules and work items" }));

beforeEach(() => {
  useSidebarTreeStore.setState({ expanded: [], projectsCollapsed: false });
  nav.searchParams = null;
  apiMock.putIssueViewPreference
    .mockReset()
    .mockImplementation(async ({ prefs }: { prefs: Record<string, unknown> }) => savedPrefs(prefs));
  installApi();
});

describe("ProjectsSection", () => {
  it("keeps the row-level behaviors the tree always had", () => {
    renderSection();
    expect(screen.getAllByText("3")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Show or hide Mobile's modules and work items" }));
    expect(useSidebarTreeStore.getState().expanded).toEqual(["project:p2"]);
    expect(screen.getAllByRole("button", { name: "Project display" })).toHaveLength(1);
  });

  it("saves a manual order for every device, keeping hidden projects after the shown ones", async () => {
    renderSection();
    act(() => dnd.onDragEnd?.({ active: { id: "p3" }, over: { id: "p1" } } as DragEndEvent));
    await waitFor(() => expect(apiMock.putIssueViewPreference).toHaveBeenCalledTimes(1));
    const { prefs } = apiMock.putIssueViewPreference.mock.calls[0]![0];
    expect(prefs.order).toEqual(["p3", "p1", "p2", "p9"]);
    expect(prefs.projects.ordering).toBe("manual");
  });

  it("creates an issue in a project from its row", () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "New issue in Mobile" }));
    expect(openCreateIssue).toHaveBeenCalledWith({ project_id: "p2" });
  });

  it("collapses from the section label", () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(useSidebarTreeStore.getState().projectsCollapsed).toBe(true);
  });
});

describe("a project's tree under the Work panel", () => {
  it("lists modules and work items, never tasks, and asks for no issue list", async () => {
    const listIssues = vi.fn(async () => ({ issues: [], total: 0 }));
    installApi({ listIssues });
    renderSection();
    expandDesktop();

    // Plan order: 01.01 before 01.02 — the fixture's row ids sort the other way.
    expect(await screen.findByText("01.01 Parser")).toBeInTheDocument();
    expect(screen.getByText("01.02 Docking")).toBeInTheDocument();
    expect(screen.getByText("No module")).toBeInTheDocument();
    // No task row, and no task read behind one.
    expect(screen.queryByText("Grammar pass")).toBeNull();
    expect(listIssues).not.toHaveBeenCalled();
  });

  it("expands a module to its work items in plan order, and itself never appears among them", async () => {
    renderSection();
    expandDesktop();
    fireEvent.click(await screen.findByRole("button", { name: "Show or hide module Docking's work items" }));

    const rows = await screen.findAllByText(/^01\.02\.0/);
    expect(rows.map((row) => row.textContent)).toEqual(["01.02.01 Interface draft", "01.02.02 Cohort handover"]);
    expect(screen.getAllByText("01.02 Docking")).toHaveLength(1);
  });

  it("caps a module's work items and points the rest at the project page", async () => {
    const many = planData();
    const items = Array.from({ length: 25 }, (_, i) => ({
      id: `wi-cap-${i}`,
      code: `01.01.${String(i + 1).padStart(2, "0")}`,
      name: `Cap ${i + 1}`,
      kind: "work_item",
      parent_id: "row-a",
      position: i,
    }));
    many.nodes = [many.nodes[0]!, many.nodes[3]!, ...items];
    installApi({ getCockpitPlan: vi.fn(async () => many) });
    renderSection();
    expandDesktop();
    fireEvent.click(await screen.findByRole("button", { name: "Show or hide module Parser's work items" }));

    expect(await screen.findByText("01.01.20 Cap 20")).toBeInTheDocument();
    expect(screen.queryByText("01.01.21 Cap 21")).toBeNull();
    const more = screen.getByText("View all 25 in the project");
    expect(more.closest("a")).toHaveAttribute("href", expect.stringContaining("node=row-a"));
  });

  it("links work items with ?node=, and lights up the one the URL names", async () => {
    const detail = structuredClone(nodeDetail);
    detail.node = { id: "wi-b0", code: "01.02.01", name: "Interface draft", kind: "work_item" };
    detail.binding = { project_id: "p1", module_id: "mod-record-2", eligible: true, reason: "" };
    installApi({ getCockpitNodeDetail: vi.fn(async () => detail) });
    nav.searchParams = new URLSearchParams({ node: "wi-b0" });
    renderSection();

    // Arrival opens the project and the module holding the selection.
    await waitFor(() => expect(useSidebarTreeStore.getState().expanded).toContain("project:p1"));
    const workItem = await screen.findByText("01.02.01 Interface draft");
    expect(workItem.closest("a")).toHaveAttribute("href", expect.stringContaining("node=wi-b0"));
    expect(workItem.closest("a")).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("01.02 Docking").closest("a")).not.toHaveAttribute("aria-current");
    useSidebarTreeStore.setState({ expanded: [] });
  });

  it("reads a row with no kind field from its parents, like the plan does", async () => {
    // An older board's detail carries no `kind`; depth is the only level
    // signal, and it must not fall back to reading the code.
    const detail = structuredClone(nodeDetail);
    detail.node = { id: "wi-b0", code: "01.02.01", name: "Interface draft" };
    detail.ancestors = [{ id: "root", code: "01", name: "Desktop" }, { id: "row-b", code: "01.02", name: "Docking" }];
    detail.binding = { project_id: "p1", module_id: "mod-record-2", eligible: true, reason: "" };
    installApi({ getCockpitNodeDetail: vi.fn(async () => detail) });
    nav.searchParams = new URLSearchParams({ node: "wi-b0" });
    renderSection();

    await waitFor(() => expect(useSidebarTreeStore.getState().expanded).toContain("project:p1"));
    const workItem = await screen.findByText("01.02.01 Interface draft");
    expect(workItem.closest("a")).toHaveAttribute("aria-current", "page");
    useSidebarTreeStore.setState({ expanded: [] });
  });

  it("lights up the module row itself for a converted ?module= selection", async () => {
    const detail = structuredClone(nodeDetail);
    detail.node = { id: "row-a", code: "01.01", name: "Parser", kind: "module", module_id: "mod-record-1", project_id: "p1" };
    detail.binding = { project_id: "p1", module_id: "mod-record-1", eligible: true, reason: "" };
    installApi({ getCockpitNodeDetail: vi.fn(async () => detail) });
    nav.searchParams = new URLSearchParams({ node: "row-a" });
    renderSection();

    await waitFor(() => expect(useSidebarTreeStore.getState().expanded).toContain("project:p1"));
    expect((await screen.findByText("01.01 Parser")).closest("a")).toHaveAttribute("aria-current", "page");
    useSidebarTreeStore.setState({ expanded: [] });
  });

  it("falls back to the module records when the board has not been reconciled", async () => {
    const unreconciled = { ...planData(), cockpit: { ...planData().cockpit!, plan_reconciled_at: null } };
    installApi({ getCockpitPlan: vi.fn(async () => unreconciled) });
    renderSection();
    expandDesktop();

    const fallbackRow = await screen.findByText("Docking");
    expect(fallbackRow.closest("a")).toHaveAttribute("href", expect.stringContaining("module=mod-record-2"));
    expect(screen.queryByText("No module")).toBeNull();
  });

  it("falls back the same way when the plan read fails outright", async () => {
    installApi({ getCockpitPlan: vi.fn(async () => { throw new Error("offline"); }) });
    renderSection();
    expandDesktop();
    expect(await screen.findByText("Docking")).toBeInTheDocument();
    expect(screen.queryByText(/could not|failed/i)).toBeNull();
  });
});
