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
  useWorkspacePaths: () => ({ projectDetail: (id: string) => `/ws/projects/${id}`, cockpit: () => "/ws/cockpit" }),
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
    full_path: "/Volumes/Space/01.01/01.01.02接口", source: "filing", meeting_id: null,
    status: "ok", shared_collab_projects: [],
    ...overrides,
  };
  directory.ensure.mockReset();
  pathActions.open.mockReset();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, common: enCommon } }}>
        <IssueDeliveryDirectory issue={{ ...issue, ...patch }} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("IssueDeliveryDirectory", () => {
  it("shows the resolved path and opens it", async () => {
    setup();
    expect(await screen.findByText("/Volumes/Space/01.01/01.01.02接口")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open folder/ }));
    expect(pathActions.open).toHaveBeenCalledWith("/Volumes/Space/01.01/01.01.02接口");
  });

  it("creates a missing folder on retry and then opens it", async () => {
    setup({ status: "missing" });
    directory.ensure.mockImplementation((_id: string, options?: { onSuccess?: (value: unknown) => void }) => {
      options?.onSuccess?.({ status: "ok", full_path: "/Volumes/Space/01.01/01.01.02接口" });
    });
    fireEvent.click(await screen.findByRole("button", { name: /Retry/ }));
    expect(directory.ensure).toHaveBeenCalledWith("i1", expect.anything());
    await waitFor(() => expect(pathActions.open).toHaveBeenCalledWith("/Volumes/Space/01.01/01.01.02接口"));
  });

  it("shows a meeting folder for an issue without a project", async () => {
    setup({ project_id: null, project_collab_path: null, full_path: "/Volumes/Space/20261127-01 周会", source: "meeting", meeting_id: "m1" }, { project_id: null });
    expect(await screen.findByText("/Volumes/Space/20261127-01 周会")).toBeInTheDocument();
  });

  it("sends a missing meeting folder to its meeting instead of creating it", async () => {
    setup({ status: "missing", full_path: "/Volumes/Space/20261127-01 周会", source: "meeting", meeting_id: "m1" });
    const link = await screen.findByRole("link", { name: "Open the meeting" });
    const href = new URL(link.getAttribute("href") ?? "", "http://localhost");
    expect(href.pathname).toBe("/ws/cockpit");
    expect(href.searchParams.get("meeting")).toBe("m1");
    expect(href.searchParams.get("meeting_view")).toBe("resources");
    expect(screen.getByText("The meeting's folder is prepared from the meeting.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry|Open folder/ })).toBeNull();
    expect(directory.ensure).not.toHaveBeenCalled();
  });

  it("keeps the retry for an unavailable meeting folder and links its meeting", async () => {
    setup({ status: "root_unavailable", full_path: "/Volumes/Space/20261127-01 周会", source: "meeting", meeting_id: "m1" });
    expect(await screen.findByRole("link", { name: "Open the meeting" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open folder/ })).toBeInTheDocument();
  });

  it("says what is missing without a project or a collaboration root", async () => {
    setup({ status: "no_collab_path", project_collab_path: null, full_path: null });
    expect(await screen.findByRole("link", { name: "Go to settings" })).toHaveAttribute("href", "/ws/projects/p1");
    expect(screen.queryByRole("button", { name: /Retry|Open folder/ })).not.toBeNull();
  });

  it("asks for a project when the issue has none", async () => {
    setup({ status: "no_collab_path", project_id: null, full_path: null }, { project_id: null });
    expect(await screen.findByText(/File the issue into a project/)).toBeInTheDocument();
  });
});
