import { beforeEach, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import { ModuleSchema } from "@multica/core/api/schemas";
import { renderWithI18n } from "../../test/i18n";
import { containerOperationFixture } from "../../issues/container-operation-test-fixture";
import { ModulesManageDialog } from "./modules-manage-dialog";

vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { listModules: vi.fn(), deleteModule: vi.fn(), getContainerOperationBasis: vi.fn() } }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit" }) }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/projects/project", searchParams: new URLSearchParams() }), AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
const module = ModuleSchema.parse({ id: "module", workspace_id: "ws-1", project_id: "project", title: "Delivery module", description: null, position: 0, created_at: "2026-10-11T00:00:00Z", updated_at: "2026-10-11T00:00:00Z" });
function setup() { const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); return renderWithI18n(<QueryClientProvider client={client}><ModulesManageDialog projectId="project" open onOpenChange={vi.fn()} /></QueryClientProvider>); }
beforeEach(() => {
  vi.resetAllMocks(); vi.mocked(api.listModules).mockResolvedValue({ modules: [module], total: 1 });
  vi.mocked(api.getContainerOperationBasis).mockImplementation(async (wsId, kind, id) => containerOperationFixture(wsId, kind, id));
});
it("shows the retained scope and actual plan destination instead of submitting a forbidden module delete", async () => {
  vi.mocked(api.getContainerOperationBasis).mockImplementation(async (wsId, kind, id) => containerOperationFixture(wsId, kind, id, { delete: { state: "blocked", reason_codes: ["retained_artifact_scope"] }, targets: [{ kind: "node", node_id: "work", view: "acceptance", label: "Accepted deliverable", purpose: "retained_scope" }], targets_total: 1 }));
  setup(); await userEvent.click(await screen.findByRole("button", { name: "Delete module" })); const dialog = await screen.findByRole("alertdialog");
  expect(await within(dialog).findByRole("link", { name: /Accepted deliverable/ })).toHaveAttribute("href", "/ws/cockpit?node=work&node_view=acceptance");
  expect(within(dialog).getByRole("button", { name: "Delete module" })).toBeDisabled(); expect(api.deleteModule).not.toHaveBeenCalled();
});
it("keeps the confirmation open after rejection and closes only after a successful explicit retry", async () => {
  vi.mocked(api.deleteModule).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
  setup(); const user = userEvent.setup(); await user.click(await screen.findByRole("button", { name: "Delete module" }));
  const dialog = await screen.findByRole("alertdialog"); await waitFor(() => expect(within(dialog).getByRole("button", { name: "Delete module" })).toBeEnabled());
  await user.click(within(dialog).getByRole("button", { name: "Delete module" })); expect(await within(dialog).findByRole("alert")).toHaveTextContent("Failed to delete module");
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Delete module" })).toBeEnabled()); await user.click(within(dialog).getByRole("button", { name: "Delete module" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()); expect(api.deleteModule).toHaveBeenCalledTimes(2);
});
