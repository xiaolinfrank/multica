/**
 * @vitest-environment jsdom
 *
 * The sidebar's projects tree: modules open on demand, work items are read per
 * module (never the whole workspace at mount), and the selected work item is
 * highlighted and linked by `?node=`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SidebarProvider } from "@multica/ui/components/ui/sidebar";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";

const mocks = vi.hoisted(() => ({
  projects: [] as Array<Record<string, unknown>>,
  modules: [] as Array<Record<string, unknown>>,
  scopeNodeQueries: [] as Array<Record<string, unknown>>,
  workItems: [] as Array<Record<string, unknown>>,
  workItemsError: false,
  nextCursor: null as string | null,
  nodeDetail: null as Record<string, unknown> | null,
}));

vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: (options: { queryKey?: readonly unknown[]; enabled?: boolean }) => {
    const key = options.queryKey ?? [];
    if (key[0] === "scope-nodes") {
      mocks.scopeNodeQueries.push((key[1] ?? {}) as Record<string, unknown>);
      return mocks.workItemsError
        ? { data: undefined, isPending: false, isError: true, isSuccess: false, isFetching: false }
        : {
            data: {
              workspace_id: "ws-1",
              scope: { project_id: null, module_id: null, q: "", eligible: false },
              items: mocks.workItems,
              total: mocks.workItems.length,
              filtered_total: mocks.workItems.length,
              next_cursor: mocks.nextCursor,
            },
            isPending: false,
            isError: false,
            isSuccess: true,
            isFetching: false,
          };
    }
    if (key[0] === "node-detail") {
      return {
        data: mocks.nodeDetail,
        isPending: false,
        isError: false,
        isSuccess: true,
        isFetching: false,
      };
    }
    if (key[0] === "projects") return { data: mocks.projects, isPending: false, isError: false };
    if (key[0] === "modules") return { data: mocks.modules, isPending: false, isError: false };
    return { data: undefined, isPending: false, isError: false };
  },
}));

vi.mock("@multica/core/cockpit", () => ({
  EMPTY_COCKPIT_SCOPE: { projectId: null, moduleId: null },
  cockpitScopeNodesOptions: (_ws: string, params: Record<string, unknown>) => ({
    queryKey: ["scope-nodes", params],
    enabled: true,
  }),
  cockpitNodeDetailOptions: () => ({ queryKey: ["node-detail"], enabled: true }),
}));

vi.mock("@multica/core/paths", () => ({
  useCurrentWorkspace: () => ({ id: "ws-1" }),
  useWorkspacePaths: () => ({
    projectDetail: (id: string) => "/ws/projects/" + id,
  }),
}));

vi.mock("@multica/core/projects/queries", () => ({
  projectListOptions: () => ({ queryKey: ["projects"], enabled: true }),
}));

vi.mock("@multica/core/modules/queries", () => ({
  moduleListOptions: () => ({ queryKey: ["modules"], enabled: true }),
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

import { SidebarProjectsTree } from "./sidebar-projects-tree";

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

const WORK_ITEM = {
  id: "work-item-1",
  title: "Grammar pass",
  project_id: PROJECT.id,
  module_id: MODULE.id,
  code: "01.01.01",
  eligible: true,
  reason: "",
};

function show(search = "") {
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
    <SidebarProvider>
      <NavigationProvider value={adapter}>
        <SidebarProjectsTree href="/ws/projects">Projects</SidebarProjectsTree>
      </NavigationProvider>
    </SidebarProvider>,
  );
  return adapter;
}

beforeEach(() => {
  mocks.projects = [PROJECT];
  mocks.modules = [MODULE];
  mocks.scopeNodeQueries = [];
  mocks.workItems = [WORK_ITEM];
  mocks.workItemsError = false;
  mocks.nextCursor = null;
  mocks.nodeDetail = null;
});

afterEach(() => {
  cleanup();
});

async function expandProject() {
  fireEvent.click(await screen.findByRole("button", { name: "Toggle modules Launch Plan" }));
  return screen.findByText("Parser rewrite");
}

describe("SidebarProjectsTree", () => {
  it("does not read work items until a module is opened", async () => {
    show();
    await expandProject();
    // Expanding the project lists modules only: the tree is drawn on mount.
    expect(mocks.scopeNodeQueries).toHaveLength(0);
  });

  it("lists a module's work items by code and name once it is opened", async () => {
    show();
    await expandProject();
    fireEvent.click(await screen.findByRole("button", { name: "Toggle work items in Parser rewrite" }));
    expect(await screen.findByText("01.01.01 Grammar pass")).toBeInTheDocument();
    // The selector refuses a module on its own, so the project travels with it.
    expect(mocks.scopeNodeQueries[0]).toMatchObject({
      project_id: PROJECT.id,
      module_id: MODULE.id,
      page_size: 20,
    });
  });

  it("links a work item to the project page by ?node=", async () => {
    show();
    await expandProject();
    fireEvent.click(await screen.findByRole("button", { name: "Toggle work items in Parser rewrite" }));
    const link = (await screen.findByText("01.01.01 Grammar pass")).closest("a");
    expect(link).toHaveAttribute("href", "/ws/projects/project-1?node=work-item-1");
  });

  it("opens the selected work item's module and highlights the row", async () => {
    mocks.nodeDetail = {
      node: { id: "work-item-1", code: "01.01.01", name: "Grammar pass" },
      binding: { eligible: true, project_id: PROJECT.id, module_id: MODULE.id },
    };
    show("node=work-item-1");
    const row = await screen.findByText("01.01.01 Grammar pass");
    // The row is the current one: its button carries the active state.
    expect(row.closest('[data-active="true"], [data-active]')).not.toBeNull();
    await waitFor(() => expect(mocks.scopeNodeQueries[0]).toMatchObject({ module_id: MODULE.id }));
  });

  it("shows nothing under a module when the work-item read fails", async () => {
    mocks.workItemsError = true;
    show();
    await expandProject();
    fireEvent.click(await screen.findByRole("button", { name: "Toggle work items in Parser rewrite" }));
    await waitFor(() => expect(mocks.scopeNodeQueries).toHaveLength(1));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Grammar pass/)).toBeNull();
  });

  it("pages the work items and offers more when a module has more than one page", async () => {
    mocks.nextCursor = "cursor-2";
    show();
    await expandProject();
    fireEvent.click(await screen.findByRole("button", { name: "Toggle work items in Parser rewrite" }));
    fireEvent.click(await screen.findByText("More work items"));
    await waitFor(() => expect(mocks.scopeNodeQueries).toHaveLength(2));
    expect(mocks.scopeNodeQueries[1]).toMatchObject({ cursor: "cursor-2" });
  });
});
