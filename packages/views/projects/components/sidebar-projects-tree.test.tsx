import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../../test/i18n";
import { SidebarProjectsTree } from "./sidebar-projects-tree";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  navigation: {
    current: {
      pathname: "/acme/projects",
      searchParams: new URLSearchParams(),
    },
  },
  projects: { current: [] as Array<Record<string, unknown>> },
  modules: { current: [] as Array<Record<string, unknown>> },
  workspace: {
    current: { id: "ws-1", name: "Acme", slug: "acme" } as {
      id: string;
      name: string;
      slug: string;
    } | null,
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({
    queryKey,
    enabled,
  }: {
    queryKey: readonly unknown[];
    enabled?: boolean;
  }) =>
    enabled === false
      ? { data: undefined }
      : queryKey[0] === "projects"
        ? { data: mocks.projects.current }
        : { data: mocks.modules.current },
}));

vi.mock("@multica/core/projects/queries", () => ({
  projectListOptions: () => ({ queryKey: ["projects"] }),
}));

vi.mock("@multica/core/modules/queries", () => ({
  moduleListOptions: () => ({ queryKey: ["modules"] }),
}));

vi.mock("@multica/core/paths", () => ({
  useCurrentWorkspace: () => mocks.workspace.current,
  useWorkspacePaths: () => ({
    projectDetail: (id: string) => "/acme/projects/" + id,
    projects: () => "/acme/projects",
  }),
}));

// The real resolver pulls the route registry from @multica/core/paths,
// which this file mocks away; the icon itself is not under test.
vi.mock("../../layout/route-icon-components", () => ({
  routeIconForPath: () => () => null,
}));

vi.mock("../../navigation", () => ({
  AppLink: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
  useNavigation: () => ({
    pathname: mocks.navigation.current.pathname,
    searchParams: mocks.navigation.current.searchParams,
  }),
}));

// Callable-store shape (selectorFn + getState) per the repo testing rules.
vi.mock("@multica/core/modals", () => ({
  useModalStore: Object.assign(vi.fn(), {
    getState: () => ({ open: mocks.open }),
  }),
}));

vi.mock("./project-icon", () => ({ ProjectIcon: () => <span /> }));

vi.mock("@multica/ui/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CollapsibleTrigger: () => <button type="button" />,
}));

vi.mock("@multica/ui/components/ui/number-flow", () => ({
  CappedNumberFlow: ({ value }: { value: number }) => <span>{value}</span>,
}));

vi.mock("@multica/ui/components/ui/sidebar", () => ({
  SidebarGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarGroupContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarMenu: ({ children }: { children: React.ReactNode }) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <li>{children}</li>,
  SidebarMenuButton: ({
    children,
    isActive,
    render,
    ...props
  }: {
    children: React.ReactNode;
    isActive?: boolean;
    render?: React.ReactElement<{ href?: string }>;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    render ? (
      <a
        {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
        href={render.props.href}
        data-active={isActive ? "true" : undefined}
      >
        {children}
      </a>
    ) : (
      <button {...props} type="button" data-active={isActive ? "true" : undefined}>
        {children}
      </button>
    ),
}));

const PROJECT = {
  id: "project-1",
  workspace_id: "ws-1",
  title: "Launch Command Center",
  description: null,
  status: "in_progress",
  icon: null,
  color: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function makeModule(id: string, title: string, issueCount: number) {
  return {
    id,
    workspace_id: "ws-1",
    project_id: "project-1",
    title,
    description: null,
    position: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    issue_count: issueCount,
    done_count: 0,
  };
}

describe("SidebarProjectsTree", () => {
  beforeEach(() => {
    mocks.open.mockReset();
    mocks.navigation.current = {
      pathname: "/acme/projects",
      searchParams: new URLSearchParams(),
    };
    mocks.workspace.current = { id: "ws-1", name: "Acme", slug: "acme" };
    mocks.projects.current = [PROJECT];
    mocks.modules.current = [
      makeModule("module-1", "Parser rewrite", 12),
      makeModule("module-2", "Sync engine", 0),
    ];
  });

  it("links the project row to the project and each module with its param", () => {
    renderWithI18n(<SidebarProjectsTree />);

    expect(
      screen.getByRole("link", { name: /launch command center/i }),
    ).toHaveAttribute("href", "/acme/projects/project-1");
    expect(
      screen.getByRole("link", { name: /parser rewrite/i }),
    ).toHaveAttribute("href", "/acme/projects/project-1?module=module-1");
    expect(
      screen.getByRole("link", { name: /sync engine/i }),
    ).toHaveAttribute("href", "/acme/projects/project-1?module=module-2");
    // The module row carries its live issue count.
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("opens create-module preselected with the project from the row hover +", async () => {
    const user = userEvent.setup();
    renderWithI18n(<SidebarProjectsTree />);

    await user.click(
      screen.getByRole("button", { name: "Add module to project" }),
    );

    expect(mocks.open).toHaveBeenCalledWith("create-module", {
      projectId: "project-1",
    });
  });

  it("marks the active module row from the ?module= param", () => {
    mocks.navigation.current.searchParams = new URLSearchParams("module=module-2");
    renderWithI18n(<SidebarProjectsTree />);

    const active = screen.getByRole("link", { name: /sync engine/i });
    expect(active).toHaveAttribute("data-active", "true");
    expect(
      screen.getByRole("link", { name: /parser rewrite/i }),
    ).not.toHaveAttribute("data-active");
    // A module deep link never lights the project row itself.
    expect(
      screen.getByRole("link", { name: /launch command center/i }),
    ).not.toHaveAttribute("data-active");
  });

  it("renders the projects-index entry when there are no projects yet", () => {
    // The label row replaces the standalone 项目 nav item, so it must never
    // disappear — the index page is where the first project gets created.
    mocks.projects.current = [];
    renderWithI18n(<SidebarProjectsTree />);

    expect(
      screen.getByRole("link", { name: /projects/i }),
    ).toHaveAttribute("href", "/acme/projects");
  });

  it("renders the index entry before the workspace resolves", () => {
    // The sidebar can mount ahead of slug resolution; the entry row is
    // path-driven, so it renders while the project/module queries wait.
    mocks.workspace.current = null;
    renderWithI18n(<SidebarProjectsTree />);

    expect(
      screen.getByRole("link", { name: /projects/i }),
    ).toBeInTheDocument();
  });

  it("links the section entry to the projects index and lights it there", () => {
    renderWithI18n(<SidebarProjectsTree />);

    const entry = screen.getByRole("link", { name: /^projects$/i });
    expect(entry).toHaveAttribute("href", "/acme/projects");
    expect(entry).toHaveAttribute("data-active", "true");
  });
});
