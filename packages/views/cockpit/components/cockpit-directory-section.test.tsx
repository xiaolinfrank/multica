import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enCockpit from "../../locales/en/cockpit.json";
import enCommon from "../../locales/en/common.json";
import type { PlanDirectoryStatus } from "@multica/core/types";
import { CockpitDirectorySection } from "./cockpit-directory-section";

const directory = vi.hoisted(() => ({
  status: null as PlanDirectoryStatus | null,
  mutate: vi.fn(),
  pending: false,
}));
const pathActions = vi.hoisted(() => ({ open: vi.fn(), copy: vi.fn() }));

vi.mock("@multica/core/directory", async (original) => ({
  ...(await original<typeof import("@multica/core/directory")>()),
  planDirectoriesOptions: () => ({ queryKey: ["test", "directories"], queryFn: async () => (directory.status ? [directory.status] : []) }),
  useSyncNodeDirectory: () => ({ mutate: directory.mutate, isPending: directory.pending }),
}));
vi.mock("@multica/core/paths", async (original) => ({
  ...(await original<typeof import("@multica/core/paths")>()),
  useWorkspacePaths: () => ({ projectDetail: (id: string) => `/ws/projects/${id}` }),
}));
vi.mock("../../common/local-path-link", async (original) => ({
  ...(await original<typeof import("../../common/local-path-link")>()),
  useLocalPathActions: () => pathActions,
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("../../navigation", () => ({
  useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams() }),
  AppLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

function renderSection(overrides: Partial<PlanDirectoryStatus> = {}) {
  directory.status = {
    node_id: "n1", kind: "work_item", project_id: "p1", project_collab_path: "/Volumes/Space",
    directory_name: "01.01确权线", expected_directory_name: "01.01确权线",
    full_path: "/Volumes/Space/01.01确权线", status: "ok", running_tasks: [], shared_collab_projects: [],
    ...overrides,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, common: enCommon } }}>
        <CockpitDirectorySection wsId="ws-1" nodeId="n1" projectId="p1" />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("CockpitDirectorySection", () => {
  it("shows a ready folder, its path, and copies it", async () => {
    renderSection();
    expect(await screen.findByText("Folder is ready")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open folder/ }));
    expect(pathActions.open).toHaveBeenCalledWith("/Volumes/Space/01.01确权线");
    fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
    expect(pathActions.copy).toHaveBeenCalledWith("/Volumes/Space/01.01确权线");
  });

  it("offers a retry when the folder is missing", async () => {
    renderSection({ status: "missing", full_path: "/Volumes/Space/01.01确权线" });
    const retry = await screen.findByRole("button", { name: /Retry/ });
    fireEvent.click(retry);
    await waitFor(() => expect(directory.mutate).toHaveBeenCalledWith({ nodeId: "n1", force: false }, expect.anything()));
  });

  it("offers a sync when the folder name drifted", async () => {
    renderSection({ status: "name_mismatch" });
    const sync = await screen.findByRole("button", { name: /Sync/ });
    fireEvent.click(sync);
    await waitFor(() => expect(directory.mutate).toHaveBeenCalled());
  });

  it("disables the actions and points at the project settings without a collaboration root", async () => {
    renderSection({ status: "no_collab_path", project_collab_path: null, full_path: null });
    expect(await screen.findByText("The project has no collaboration space path")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to settings" })).toHaveAttribute("href", "/ws/projects/p1");
    expect(screen.queryByRole("button", { name: /Retry|Sync/ })).toBeNull();
  });

  it("names the other workspaces that share the root", async () => {
    renderSection({
      shared_collab_projects: [{
        workspace_id: "w2", workspace_slug: "other", workspace_name: "Other team",
        project_id: "p2", project_title: "Shared project",
      }],
    });
    expect(await screen.findByText(/Other team \/ Shared project/)).toBeInTheDocument();
  });
});
