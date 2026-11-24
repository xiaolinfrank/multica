import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { CockpitMeetingDefaultsDialog } from "./cockpit-meeting-defaults-dialog";
import en from "../../locales/en/cockpit.json";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ projects: () => "/ws/projects", projectDetail: (id: string) => `/ws/projects/${id}` }),
}));
vi.mock("../../navigation", () => ({
  AppLink: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
  useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams("tab=meetings") }),
}));
vi.mock("@multica/core/api", async (original) => ({
  ...(await original<typeof import("@multica/core/api")>()),
  api: { updateCockpit: vi.fn(), getCockpitMeetingDestination: vi.fn(), listProjects: vi.fn(), listModules: vi.fn(), getCockpitPlan: vi.fn(), getCockpitNodeDetail: vi.fn(), searchCockpitScopeNodes: vi.fn() },
}));

function show(props: Partial<React.ComponentProps<typeof CockpitMeetingDefaultsDialog>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <I18nProvider locale="en" resources={{ en: { cockpit: en, common: enCommon, issues: enIssues } }}>
        <CockpitMeetingDefaultsDialog
          wsId="ws-1"
          open
          onOpenChange={onOpenChange}
          scope={{ projectId: null, moduleId: null }}
          defaultProjectId="project"
          defaultModuleId="module"
          defaultNodeId="node-work"
          {...props}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listProjects).mockResolvedValue({ projects: [{ id: "project", title: "Programme" }], total: 1 } as unknown as Awaited<ReturnType<typeof api.listProjects>>);
  vi.mocked(api.listModules).mockResolvedValue({ modules: [{ id: "module", project_id: "project", title: "Module" }], total: 1 } as unknown as Awaited<ReturnType<typeof api.listModules>>);
  vi.mocked(api.getCockpitMeetingDestination).mockResolvedValue({
    project_id: "project", project_title: "Programme", module_id: "module", module_title: "Module",
    node_id: "node-work", node_code: "01.02.01", node_title: "Draft", collab_path: "/Volumes/team",
    base_dir: "/Volumes/team/Meetings/Draft", derived: true, base_dir_exists: false, creatable: true, error: "",
  });
  vi.mocked(api.updateCockpit).mockResolvedValue({ id: "cp", workspace_id: "ws-1" } as unknown as Awaited<ReturnType<typeof api.updateCockpit>>);
});

describe("default meeting location", () => {
  it("previews the folder and saves the three-level selection with empty strings for cleared levels", async () => {
    const { onOpenChange } = show();
    expect(await screen.findByText(/\/Volumes\/team\/Meetings\/Draft/)).toBeInTheDocument();
    expect(screen.getByText(/does not exist yet and will be created/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.meetings.defaults_save }));
    await waitFor(() => expect(api.updateCockpit).toHaveBeenCalledExactlyOnceWith({
      meeting_project_id: "project", meeting_module_id: "module", meeting_node_id: "node-work",
    }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("clears every level as empty strings rather than omitted fields", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: en.meetings.defaults_clear }));
    fireEvent.click(screen.getByRole("button", { name: en.meetings.defaults_save }));
    await waitFor(() => expect(api.updateCockpit).toHaveBeenCalledExactlyOnceWith({
      meeting_project_id: "", meeting_module_id: "", meeting_node_id: "",
    }));
  });

  it("keeps the dialog open and names the reason when saving fails", async () => {
    vi.mocked(api.updateCockpit).mockRejectedValueOnce(new Error("module does not belong to the project"));
    const { onOpenChange } = show();
    fireEvent.click(await screen.findByRole("button", { name: en.meetings.defaults_save }));
    expect(await screen.findByRole("alert")).toHaveTextContent("module does not belong to the project");
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
