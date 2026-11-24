import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enCockpit from "../../locales/en/cockpit.json";
import enCommon from "../../locales/en/common.json";
import type { Issue, IssueDirectoryStatus } from "@multica/core/types";
import { IssueDeliveryDirectory } from "./issue-delivery-directory";

const directory = vi.hoisted(() => ({
  status: null as IssueDirectoryStatus | null,
  ensure: vi.fn(),
  pending: false,
}));
const pathActions = vi.hoisted(() => ({ open: vi.fn(), copy: vi.fn() }));

vi.mock("@multica/core/directory", async (original) => ({
  ...(await original<typeof import("@multica/core/directory")>()),
  issueDirectoryOptions: () => ({ queryKey: ["test", "issue-directory"], queryFn: async () => directory.status }),
  useEnsureIssueDirectory: () => ({ mutate: directory.ensure, isPending: directory.pending }),
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/paths", async (original) => ({
  ...(await original<typeof import("@multica/core/paths")>()),
  useWorkspacePaths: () => ({ projectDetail: (id: string) => `/ws/projects/${id}` }),
}));
vi.mock("../../common/local-path-link", async (original) => ({
  ...(await original<typeof import("../../common/local-path-link")>()),
  useLocalPathActions: () => pathActions,
}));
vi.mock("../../navigation", () => ({
  useNavigation: () => ({ pathname: "/ws/issues/1", searchParams: new URLSearchParams() }),
  AppLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const issue = {
  id: "i1", identifier: "TES-7", title: "注册路径设计", project_id: "p1", module_id: null, work_item_id: null,
} as unknown as Issue;

function setup(overrides: Partial<IssueDirectoryStatus> = {}, patch: Partial<Issue> = {}) {
  directory.status = {
    issue_id: "i1", project_id: "p1", project_collab_path: "/Volumes/Space",
    directory_name: "TES-7注册路径设计", full_path: "/Volumes/Space/01.01/TES-7注册路径设计",
    status: "ok", running_tasks: [], shared_collab_projects: [],
    ...overrides,
  };
  const onUpdate = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, common: enCommon } }}>
        <IssueDeliveryDirectory issue={{ ...issue, ...patch }} onUpdate={onUpdate} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onUpdate };
}

describe("IssueDeliveryDirectory", () => {
  it("shows the composed path and opens it", async () => {
    setup();
    expect(await screen.findByText("/Volumes/Space/01.01/TES-7注册路径设计")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open folder/ }));
    expect(pathActions.open).toHaveBeenCalledWith("/Volumes/Space/01.01/TES-7注册路径设计");
  });

  it("allocates and creates the folder on the first open", async () => {
    setup({ status: "unallocated", directory_name: null, full_path: null });
    fireEvent.click(await screen.findByRole("button", { name: /Retry/ }));
    expect(directory.ensure).toHaveBeenCalledWith("i1", expect.anything());
  });

  it("points the issue at a hand-picked folder name without moving files", async () => {
    const { onUpdate } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Change folder name" }));
    const input = screen.getByRole("textbox", { name: "Change folder name" });
    expect(screen.getByText(/existing files are not moved/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "旧文件夹" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ directory_name: "旧文件夹" }));
  });

  it("says what is missing without a project or a collaboration root", async () => {
    setup({ status: "no_collab_path", project_collab_path: null, full_path: null });
    expect(await screen.findByRole("link", { name: "Go to settings" })).toHaveAttribute("href", "/ws/projects/p1");
    expect(screen.queryByRole("button", { name: /Retry|Open folder/ })).not.toBeNull();
  });

  it("asks for a project when the issue has none", async () => {
    setup({ status: "no_collab_path", project_id: null }, { project_id: null });
    expect(await screen.findByText(/File the issue into a project/)).toBeInTheDocument();
  });
});
