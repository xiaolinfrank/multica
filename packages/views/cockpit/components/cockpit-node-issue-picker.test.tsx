import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitNodeIssuePicker, useCockpitSelectedNodeIssueOption } from "./cockpit-node-issue-picker";
import { CockpitNodeChoicePicker } from "./cockpit-node-choice";
import { CockpitNodeSchema } from "@multica/core/api/schemas";
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams() }) }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/api", () => ({ api: { getCockpitNodeIndex: vi.fn(), searchCockpitScopeNodes: vi.fn(), getCockpitNodeDetail: vi.fn(), getCockpit: vi.fn(), listModules: vi.fn() } }));
function wrap(children: React.ReactNode) { const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); return render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>{children}</I18nProvider></QueryClientProvider>); }
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.getCockpitNodeIndex).mockResolvedValue({ workspace_id: "ws-1", total: 3, items: [{ id: "root", parent_id: null, code: "L1-01", position: 0 }, { id: "first-node", parent_id: "root", code: "L3-1", position: 0 }, { id: "last-node", parent_id: "root", code: "L3-2", position: 1 }] }); vi.mocked(api.searchCockpitScopeNodes).mockImplementation(async (_ws, params = {}) => ({ workspace_id: "ws-1", scope: { project_id: null, module_id: null, q: params.q ?? "", eligible: true },
  items: [{ id: params.cursor ? "last-node" : "first-node", title: params.cursor ? "Last work item" : "First work item", code: params.cursor ? "L3-2" : "L3-1", project_id: "project", module_id: "module", eligible: true, reason: "" }], total: 21, filtered_total: 21, next_cursor: params.cursor ? null : "page-2" })); });
describe("bounded cockpit node selection", () => {
  it("requests twenty choices only after opening and selects an item beyond the first server page", async () => {
    const select = vi.fn(); wrap(<CockpitNodeIssuePicker value={null} onUpdate={select} />); const user = userEvent.setup();
    expect(api.searchCockpitScopeNodes).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button")); await screen.findByRole("button", { name: "01.01 First work item" });
    expect(vi.mocked(api.searchCockpitScopeNodes).mock.lastCall?.[1]).toMatchObject({ page_size: 20, eligible: true });
    await user.click(screen.getByRole("button", { name: "Next page" })); await user.click(await screen.findByRole("button", { name: "01.02 Last work item" }));
    expect(select).toHaveBeenCalledWith({ node_id: "last-node", code: "01.02", label: "01.02 Last work item", project_id: "project", module_id: "module" });
    expect(api.getCockpit).not.toHaveBeenCalled(); expect(api.listModules).not.toHaveBeenCalled();
  });
  it("returns to the first page when changing a search and clearing it", async () => {
    wrap(<CockpitNodeIssuePicker value={null} onUpdate={vi.fn()} />); const user = userEvent.setup(); await user.click(screen.getByRole("button"));
    await screen.findByRole("button", { name: "01.01 First work item" }); await user.click(screen.getByRole("button", { name: "Next page" })); await screen.findByRole("button", { name: "01.02 Last work item" });
    const input = screen.getByRole("textbox"); await user.type(input, "other"); await waitFor(() => expect(vi.mocked(api.searchCockpitScopeNodes).mock.lastCall?.[1]).toMatchObject({ q: "other", cursor: undefined }));
    await user.clear(input); await screen.findByRole("button", { name: "01.01 First work item" }); expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
  });
  it("keeps failed relationship selection open until the exact write is confirmed", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("scope changed")).mockResolvedValueOnce(undefined);
    wrap(<CockpitNodeChoicePicker wsId="ws-1" label="Link work item" eligible={false} onSelect={save} />); const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Link work item" }));
    await user.click(await screen.findByRole("button", { name: "01.01 First work item" })); expect(await screen.findByRole("alert")).toHaveTextContent("scope changed");
    await user.click(screen.getByRole("button", { name: "01.01 First work item" })); await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull()); expect(save).toHaveBeenCalledTimes(2);
  });
  it("resolves a saved node by identity, independently of the search page, and refuses structural bindings as execution tasks", async () => {
    const node = CockpitNodeSchema.parse({ id: "saved-node", code: "L3-1", name: "Saved work item" });
    const value = { workspace_id: "ws-1", scope: { project_id: null, module_id: null, project_title: "", module_title: "" }, cockpit: null, actor: { user_id: "person", role: "member", is_human: true }, has_meeting_workflows: false, has_stable_bindings: true,
      node, ancestors: [], children_count: 0, scope_match: true, node_index: [node], binding: { project_id: "project", module_id: "module", project_title: "P", module_title: "M", source_node_id: "parent", eligible: true, reason: "" }, payments: { items: [], total: 0, next_cursor: null }, payment_total: 0, meetings: { items: [], total: 0, next_cursor: null } };
    vi.mocked(api.getCockpitNodeDetail).mockResolvedValue(value);
    function Reader() { const selected = useCockpitSelectedNodeIssueOption("saved-node"); return <p>{selected.option?.label || "unavailable"}</p>; }
    const first = wrap(<Reader />); expect(await screen.findByText(/Saved work item/)).toBeVisible(); expect(api.searchCockpitScopeNodes).not.toHaveBeenCalled();
    first.unmount(); vi.mocked(api.getCockpitNodeDetail).mockResolvedValue({ ...value, node: { ...node, project_id: "project", module_id: "module" }, binding: { ...value.binding, eligible: false, reason: "structural_binding" } });
    wrap(<Reader />); await waitFor(() => expect(api.getCockpitNodeDetail).toHaveBeenCalledTimes(2)); expect(screen.getByText("unavailable")).toBeVisible();
  });
});

  it("resolves an exact displayed code to an identity query while preserving project and module scope", async () => {
    const nodeId = "11111111-1111-4111-8111-111111111111";
    vi.mocked(api.getCockpitNodeIndex).mockResolvedValue({ workspace_id: "ws-1", total: 1, items: [{ id: nodeId, parent_id: null, code: "L1-03", position: 0 }] });
    vi.mocked(api.searchCockpitScopeNodes).mockImplementation(async (_ws, params = {}) => ({ workspace_id: "ws-1", scope: { project_id: "project", module_id: "module", q: params.q ?? "", eligible: true }, items: [{ id: nodeId, title: "Target row", code: "L1-03", project_id: "project", module_id: "module", eligible: true, reason: "" }], total: 1, filtered_total: 1, next_cursor: null }));
    wrap(<CockpitNodeChoicePicker wsId="ws-1" scope={{ projectId: "project", moduleId: "module" }} label="Choose work item" onSelect={vi.fn()} />);
    const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Choose work item" })); await screen.findByRole("button", { name: "03 Target row" }); await user.type(screen.getByRole("textbox"), "03");
    await waitFor(() => expect(vi.mocked(api.searchCockpitScopeNodes).mock.lastCall?.[1]).toMatchObject({ q: nodeId, project_id: "project", module_id: "module", page_size: 20 }));
    expect(screen.getByRole("button", { name: "03 Target row" })).toBeVisible();
  });
