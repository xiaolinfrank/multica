/**
 * @vitest-environment jsdom
 *
 * The sidebar's projects tree: modules open on demand, a module's work items
 * are read from the module-scoped plan (never the whole workspace at mount),
 * listed in plan order without the module's own row, and the selected row is
 * highlighted and linked by `?node=`.
 *
 * Everything the tree reads is mocked at the API layer, so the reads it
 * actually makes are the reads asserted here — not the query-option shapes
 * that once let a refused request through unnoticed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { SidebarProvider } from "@multica/ui/components/ui/sidebar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { SidebarProjectsTree } from "./sidebar-projects-tree";

vi.mock("@multica/core/paths", () => ({
  useCurrentWorkspace: () => ({ id: "ws-1" }),
  useWorkspacePaths: () => ({
    projectDetail: (id: string) => "/ws/projects/" + id,
  }),
}));

vi.mock("@multica/core/modals", () => ({
  useModalStore: { getState: () => ({ open: vi.fn() }) },
}));

vi.mock("../../navigation", async (original) => ({
  ...(await original<typeof import("../../navigation")>()),
  AppLink: ({ href, children, ...props }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const PROJECT = {
  id: "project-1",
  workspace_id: "ws-1",
  title: "Launch Plan",
  description: null,
  icon: "📁",
  color: null,
  status: "active",
  priority: "medium",
  lead_type: null,
  lead_id: null,
  start_date: null,
  due_date: null,
  collab_path: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  issue_count: 0,
  done_count: 0,
  resource_count: 0,
};

const MODULE = {
  id: "module-1",
  workspace_id: "ws-1",
  project_id: PROJECT.id,
  title: "Parser rewrite",
  description: null,
  position: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  issue_count: 2,
  done_count: 0,
};

const MODULE_ROW_ID = "node-module";

/** The plan rows: the ids sort in the OPPOSITE order to the codes, so a list
 *  ordered by id would read 01.01.02 before 01.01.01. */
function planNodes(count = 2) {
  return [
    {
      id: MODULE_ROW_ID,
      code: "01.01",
      name: "Parser rewrite",
      kind: "module",
      parent_id: null,
      position: 0,
      project_id: PROJECT.id,
      module_id: MODULE.id,
    },
    ...Array.from({ length: count }, (_, index) => {
      const number = String(index + 1).padStart(2, "0");
      return {
        // Descending ids, ascending codes.
        id: `zzzz-${100 - index}`,
        code: `01.01.${number}`,
        name: `Work ${number}`,
        kind: "work_item",
        parent_id: MODULE_ROW_ID,
        position: index,
        project_id: PROJECT.id,
        module_id: null,
      };
    }),
  ];
}

function planSurface(count = 2) {
  return {
    workspace_id: "ws-1",
    scope: { project_id: PROJECT.id, module_id: MODULE.id, project_title: "Launch Plan", module_title: "Parser rewrite" },
    cockpit: { id: "cp", workspace_id: "ws-1", goal_date: null, plan_reconciled_at: "2026-11-20T00:00:00Z" },
    actor: { user_id: "user-1", role: "owner", is_human: true },
    has_meeting_workflows: false,
    has_stable_bindings: false,
    complete: true,
    nodes: planNodes(count),
    task_counts: [],
    context_node_ids: [],
    payments: [],
    milestones: [],
    node_index: [],
  };
}

const planCalls: string[] = [];

beforeEach(() => {
  cleanup();
  planCalls.length = 0;
  setApiInstance({
    listProjects: async () => ({ projects: [PROJECT], total: 1 }),
    listModules: async () => ({ modules: [MODULE], total: 1 }),
    getCockpitPlan: async (_wsId: string, _scope: unknown) => {
      planCalls.push("plan");
      return planSurface();
    },
    getCockpitNodeDetail: async () => null,
  } as unknown as ApiClient);
});

afterEach(() => {
  cleanup();
});

function show(search = "") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const adapter: NavigationAdapter = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/ws/projects/project-1",
    searchParams: new URLSearchParams(search),
    hash: "",
    getShareableUrl: (path: string) => path,
  };
  renderWithI18n(
    <QueryClientProvider client={queryClient}>
      <SidebarProvider>
        <NavigationProvider value={adapter}>
          <SidebarProjectsTree href="/ws/projects">Projects</SidebarProjectsTree>
        </NavigationProvider>
      </SidebarProvider>
    </QueryClientProvider>,
  );
}

async function expandProject() {
  fireEvent.click(await screen.findByRole("button", { name: "Toggle modules Launch Plan" }));
  return screen.findByText("Parser rewrite");
}

async function openModule() {
  await expandProject();
  fireEvent.click(await screen.findByRole("button", { name: "Toggle work items in Parser rewrite" }));
}

describe("SidebarProjectsTree", () => {
  it("reads no work items until a module is opened", async () => {
    show();
    await expandProject();
    expect(planCalls).toHaveLength(0);
  });

  it("lists only work items, in plan order — never the module's own row", async () => {
    show();
    await openModule();

    expect(await screen.findByText("01.01.01 Work 01")).toBeInTheDocument();
    expect(await screen.findByText("01.01.02 Work 02")).toBeInTheDocument();
    const codes = screen.getAllByText(/^01\.01\.\d/).map((node) => node.textContent);
    expect(codes).toEqual(["01.01.01 Work 01", "01.01.02 Work 02"]);
    // One "Parser rewrite": the module row itself, not a second copy listed
    // as one of its own children.
    expect(screen.getAllByText("Parser rewrite")).toHaveLength(1);
  });

  it("links a work item to the project page by ?node=", async () => {
    show();
    await openModule();
    const link = (await screen.findByText("01.01.01 Work 01")).closest("a");
    expect(link).toHaveAttribute("href", "/ws/projects/project-1?node=zzzz-100");
  });

  it("caps the list at twenty and offers the whole module in the project page", async () => {
    setApiInstance({
      listProjects: async () => ({ projects: [PROJECT], total: 1 }),
      listModules: async () => ({ modules: [MODULE], total: 1 }),
      getCockpitPlan: async () => planSurface(25),
      getCockpitNodeDetail: async () => null,
    } as unknown as ApiClient);

    show();
    await openModule();

    await screen.findByText("01.01.20 Work 20");
    // Only the first twenty, though the module has twenty-five.
    expect(screen.queryByText("01.01.21 Work 21")).toBeNull();
    expect(screen.getAllByText(/^01\.01\.\d/)).toHaveLength(20);
    const more = (await screen.findByText("View all 25 in the project")).closest("a");
    expect(more).toHaveAttribute("href", "/ws/projects/project-1?node=node-module");
  });

  it("highlights the selected work item and opens its module on arrival", async () => {
    setApiInstance({
      listProjects: async () => ({ projects: [PROJECT], total: 1 }),
      listModules: async () => ({ modules: [MODULE], total: 1 }),
      getCockpitPlan: async () => planSurface(),
      getCockpitNodeDetail: async () => ({
        node: { id: "zzzz-100", code: "01.01.01", name: "Work 01", kind: "work_item", module_id: null },
        binding: { eligible: true, project_id: PROJECT.id, module_id: MODULE.id },
      }),
    } as unknown as ApiClient);

    show("node=zzzz-100");
    const row = await screen.findByText("01.01.01 Work 01");
    expect(row.closest('[data-active="true"], [data-active]')).not.toBeNull();
  });

  it("highlights the module row for a converted `?node=` link too", async () => {
    setApiInstance({
      listProjects: async () => ({ projects: [PROJECT], total: 1 }),
      listModules: async () => ({ modules: [MODULE], total: 1 }),
      getCockpitPlan: async () => planSurface(),
      getCockpitNodeDetail: async () => ({
        node: { id: MODULE_ROW_ID, code: "01.01", name: "Parser rewrite", kind: "module", module_id: MODULE.id },
        binding: { eligible: true, project_id: PROJECT.id, module_id: MODULE.id },
      }),
    } as unknown as ApiClient);

    show("node=node-module");
    // An old `?module=` link is rewritten to the module's row by the project
    // page; the highlight must survive that conversion.
    const row = await screen.findByText("Parser rewrite");
    expect(row.closest('[data-active="true"], [data-active]')).not.toBeNull();
  });

  it("stays silent when the plan read fails", async () => {
    setApiInstance({
      listProjects: async () => ({ projects: [PROJECT], total: 1 }),
      listModules: async () => ({ modules: [MODULE], total: 1 }),
      getCockpitPlan: async () => {
        throw new Error("403");
      },
      getCockpitNodeDetail: async () => null,
    } as unknown as ApiClient);

    show();
    await openModule();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Work 01/)).toBeNull();
  });
});
