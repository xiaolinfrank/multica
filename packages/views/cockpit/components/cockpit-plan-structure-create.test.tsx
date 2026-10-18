import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api, ApiError } from "@multica/core/api";
import { CockpitNodeSchema, CockpitBoardSchema } from "@multica/core/api/schemas";
import { useCockpitPlanNodeDraftStore } from "@multica/core/cockpit";
import { containerOperationFixture } from "../../issues/container-operation-test-fixture";
import enIssues from "../../locales/en/issues.json";
import enCockpit from "../../locales/en/cockpit.json";
import { cockpitNodeDetailFixture } from "./cockpit-read-test-fixture";
import { CockpitPlanStructureCreate } from "./cockpit-plan-structure-create";
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getContainerOperationBasis: vi.fn(), getCockpitContext: vi.fn(), searchCockpitScopes: vi.fn(), getCockpitNodeCodePreview: vi.fn(), getCockpitNodeDetail: vi.fn(), getCockpitNodeIndex: vi.fn(), searchCockpitScopeNodes: vi.fn(), createCockpitNode: vi.fn() } }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", projects: () => "/ws/projects", projectDetail: (id: string) => `/ws/projects/${id}` }) }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams("tab=plan") }), AppLink: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }));
const scope = { projectId: null, moduleId: null };
const created = CockpitNodeSchema.parse({ id: "new-row", code: "L1-01", name: "Project execution", parent_id: null, project_id: "project-1", module_id: null });
function setup(defaultKind: "project" | "module" | "task" = "project") { const onCreated = vi.fn(); const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues } }}>{children}</I18nProvider></QueryClientProvider>;
  return { ...render(<CockpitPlanStructureCreate wsId="ws-1" scope={scope} defaultKind={defaultKind} onCreated={onCreated} />, { wrapper }), onCreated };
}
beforeEach(() => {
  vi.mocked(api.getContainerOperationBasis).mockImplementation(async (wsId, kind, id) => containerOperationFixture(wsId, kind, id)); vi.clearAllMocks(); useCockpitPlanNodeDraftStore.getState().clearDraft();
  vi.mocked(api.getCockpitContext).mockImplementation(async (_ws, input) => ({ workspace_id: "ws-1", scope: { project_id: input.projectId, module_id: input.moduleId, project_title: "Existing project", module_title: "" }, cockpit: null, actor: { user_id: "person", role: "member", is_human: true }, has_stable_bindings: false, has_meeting_workflows: false }));
  vi.mocked(api.searchCockpitScopes).mockResolvedValue({ workspace_id: "ws-1", project_id: null, items: [{ id: "project-1", title: "Existing project", project_id: null }], total: 1, next_cursor: null });
  vi.mocked(api.getCockpitNodeCodePreview).mockResolvedValue({ workspace_id: "ws-1", parent_id: null, code: "L1-01" });
  vi.mocked(api.createCockpitNode).mockImplementation(async (body) => ({ ...created, ...body, code: "LOCKED-002", creation_key: body.creation_key, replayed: false }));
});
async function fill() { const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Add plan item" })); await user.click(screen.getByRole("button", { name: "Project" })); await user.click(await screen.findByRole("button", { name: "Existing project" })); await user.type(screen.getByRole("textbox", { name: "Name" }), "Project execution"); await waitFor(() => expect(screen.getByRole("button", { name: "Create plan item" })).not.toBeDisabled()); return user; }
describe("explicit plan structure creation", () => {
  it("creates an explicitly UUID-mapped project and lets the server choose sibling order", async () => {
    const { onCreated } = setup(); const user = await fill(); await user.click(screen.getByRole("button", { name: "Create plan item" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("new-row")); expect(api.createCockpitNode).toHaveBeenCalledExactlyOnceWith({ creation_key: expect.any(String), auto_code: true, name: "Project execution", parent_id: null, project_id: "project-1", module_id: null, status: "" }, "ws-1");
  });
  it("keeps the original creation command and input after an unknown result instead of issuing another creation intent", async () => {
    vi.mocked(api.createCockpitNode).mockRejectedValueOnce(new Error("connection lost")); const { onCreated } = setup(); const user = await fill();
    await user.click(screen.getByRole("button", { name: "Create plan item" })); expect(await screen.findByText("connection lost")).toBeVisible(); expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
    const previewReads = vi.mocked(api.getCockpitNodeCodePreview).mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Retry" })); await waitFor(() => expect(onCreated).toHaveBeenCalledWith("new-row"));
    expect(api.createCockpitNode).toHaveBeenCalledTimes(2); expect(vi.mocked(api.createCockpitNode).mock.calls[1]?.[0]).toEqual(vi.mocked(api.createCockpitNode).mock.calls[0]?.[0]);
    expect(api.getCockpitNodeCodePreview).toHaveBeenCalledTimes(previewReads);
  });
});

function mappedParent(code = "AI-03-02", moduleId: string | null = "module") {
  const board = CockpitBoardSchema.parse({ cockpit: { id: "board" }, nodes: [{ id: "mapped-parent", code, name: "Mapped parent", project_id: "project", module_id: moduleId }] });
  vi.mocked(api.getCockpitNodeIndex).mockResolvedValue({ workspace_id: "ws-1", items: board.nodes, total: 1 });
  vi.mocked(api.searchCockpitScopeNodes).mockResolvedValue({ workspace_id: "ws-1", scope: { project_id: null, module_id: null, q: "", eligible: false }, items: [{ id: "mapped-parent", code, title: "Mapped parent", project_id: "project", module_id: moduleId, eligible: false, reason: "structural_binding" }], total: 1, filtered_total: 1, next_cursor: null });
  vi.mocked(api.getCockpitNodeDetail).mockResolvedValue(cockpitNodeDetailFixture(board, "mapped-parent"));
  vi.mocked(api.getCockpitNodeCodePreview).mockResolvedValue({ workspace_id: "ws-1", parent_id: "mapped-parent", code: "NEXT-001" });
}
describe("plan creation parent contract", () => {
  it.each(["01.02", "AI-03-02", "arbitrary-stored-code"])("uses explicit inherited module identity for parent %s without inferring hierarchy from its code", async (code) => {
    mappedParent(code); const { onCreated } = setup("task"); const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Add plan item" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "New execution work"); expect(screen.getByRole("button", { name: "Create plan item" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Parent plan item" })); await user.click(await screen.findByRole("button", { name: /Mapped parent/ })); await waitFor(() => expect(screen.getByRole("button", { name: "Create plan item" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Create plan item" })); await waitFor(() => expect(onCreated).toHaveBeenCalledWith("new-row"));
    expect(api.createCockpitNode).toHaveBeenCalledExactlyOnceWith({ creation_key: expect.any(String), auto_code: true, name: "New execution work", parent_id: "mapped-parent", project_id: null, module_id: null, status: "" }, "ws-1");
  });
  it("keeps an unbound parent ineligible and cancels without creating", async () => {
    mappedParent("looks-like-L3", null); setup("task"); const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Add plan item" })); await user.type(screen.getByRole("textbox", { name: "Name" }), "New work");
    await user.click(screen.getByRole("button", { name: "Parent plan item" })); await user.click(await screen.findByRole("button", { name: /Mapped parent/ })); expect(await screen.findByText(enCockpit.plan_structure.invalid_parent)).toBeVisible();
    expect(screen.getByRole("button", { name: "Create plan item" })).toBeDisabled(); await user.click(screen.getByRole("button", { name: "Cancel" })); expect(api.createCockpitNode).not.toHaveBeenCalled();
  });
  it("lets the server assign the number when its optional preview is unavailable", async () => {
    vi.mocked(api.getCockpitNodeCodePreview).mockRejectedValue(new Error("Code service unavailable")); const view = setup(); const user = await fill();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load"); expect(screen.getByRole("button", { name: "Create plan item" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Create plan item" })); await waitFor(() => expect(view.onCreated).toHaveBeenCalledWith("new-row"));
    expect(vi.mocked(api.createCockpitNode).mock.calls[0]?.[0]).toMatchObject({ auto_code: true, creation_key: expect.any(String) }); expect(vi.mocked(api.createCockpitNode).mock.calls[0]?.[0]).not.toHaveProperty("code");
  });
  it("does not navigate after the confirmed creation returns to an unmounted form", async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.createCockpitNode>>) => void; vi.mocked(api.createCockpitNode).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = setup(); const user = await fill(); await user.click(screen.getByRole("button", { name: "Create plan item" })); await waitFor(() => expect(api.createCockpitNode).toHaveBeenCalledOnce()); const command = vi.mocked(api.createCockpitNode).mock.calls[0]![0]; view.unmount();
    await act(async () => finish({ ...created, ...command, code: "LOCKED-002", creation_key: command.creation_key, replayed: false })); expect(view.onCreated).not.toHaveBeenCalled(); expect(useCockpitPlanNodeDraftStore.getState().draft.byScope).toEqual({});
  });
});

  it("opens an existing UUID binding after the server confirms this exact creation was refused", async () => {
    const existingId = "10000000-0000-4000-8000-000000000099";
    vi.mocked(api.createCockpitNode).mockImplementationOnce(async (body) => { throw new ApiError("Project already mapped", 409, "Conflict", { code: "node_binding_exists", workspace_id: "ws-1", creation_key: body.creation_key, existing_node_id: existingId }); });
    setup(); const user = await fill(); await user.click(screen.getByRole("button", { name: "Create plan item" }));
    expect(await screen.findByRole("link", { name: enCockpit.plan_structure.open_existing })).toHaveAttribute("href", `/ws/cockpit?node=${existingId}&node_view=details`);
    expect(screen.getByRole("textbox", { name: "Name" })).toBeEnabled(); expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Project execution");
  });
  it("retains the same key for an unclassified conflict instead of silently issuing another creation", async () => {
    vi.mocked(api.createCockpitNode).mockRejectedValueOnce(new ApiError("Unknown conflict", 409, "Conflict")); setup(); const user = await fill(); await user.click(screen.getByRole("button", { name: "Create plan item" })); await screen.findByText("Unknown conflict");
    expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled(); expect(screen.queryByRole("link", { name: enCockpit.plan_structure.open_existing })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" })); await waitFor(() => expect(api.createCockpitNode).toHaveBeenCalledTimes(2)); expect(vi.mocked(api.createCockpitNode).mock.calls[1]).toEqual(vi.mocked(api.createCockpitNode).mock.calls[0]);
  });

it("does not turn a retained execution leaf into a group, while preserving the typed plan name", async () => {
  mappedParent(); vi.mocked(api.getContainerOperationBasis).mockImplementation(async (wsId, kind, id) => containerOperationFixture(wsId, kind, id, { add_child: { state: "blocked", reason_codes: ["retained_execution_leaf"] } }));
  setup("task"); const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Add plan item" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Keep this planned item");
  await user.click(screen.getByRole("button", { name: "Parent plan item" })); await user.click(await screen.findByRole("button", { name: /Mapped parent/ }));
  expect(await screen.findByText(enIssues.operation_basis.execution_leaf)).toBeVisible();
  expect(screen.getByRole("button", { name: "Create plan item" })).toBeDisabled(); expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Keep this planned item"); expect(api.createCockpitNode).not.toHaveBeenCalled();
});
