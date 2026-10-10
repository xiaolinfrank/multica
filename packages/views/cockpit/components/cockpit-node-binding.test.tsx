import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { CockpitNodeSchema } from "@multica/core/api/schemas";
import type { CockpitNode, CockpitNodeBindingContext } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitNodeBindingField } from "./cockpit-node-binding";

vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ projects: () => "/ws/projects", projectDetail: (id: string) => `/ws/projects/${id}` }) }));
vi.mock("../../navigation", () => ({ AppLink: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }));
vi.mock("@multica/core/api", () => ({ api: { getCockpitContext: vi.fn(), searchCockpitScopes: vi.fn() } }));
import { api } from "@multica/core/api";
const projectNode = CockpitNodeSchema.parse({ id: "project-row", name: "Project", project_id: "p1" });
const moduleNode = CockpitNodeSchema.parse({ id: "module-row", parent_id: "project-row", name: "Module" });
const taskNode = CockpitNodeSchema.parse({ id: "task-row", parent_id: "module-row", code: "01.01.01" });
function binding(overrides: Partial<CockpitNodeBindingContext> = {}): CockpitNodeBindingContext {
  return { project_id: "p1", module_id: null, project_title: "Existing project", module_title: "", source_node_id: "project-row", eligible: false, reason: "module_binding_required", ...overrides };
}
function setup(node: CockpitNode, onSave = vi.fn().mockResolvedValue(undefined), value = binding()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); const onOpenNode = vi.fn();
  render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>
    <CockpitNodeBindingField wsId="ws-1" node={node} ancestors={[projectNode, moduleNode]} binding={value} onSave={onSave} onOpenNode={onOpenNode} />
  </I18nProvider></QueryClientProvider>); return { onSave, onOpenNode };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getCockpitContext).mockImplementation(async (_wsId, scope) => ({ workspace_id: "ws-1", scope: { project_id: scope.projectId, module_id: scope.moduleId,
    project_title: "Existing project", module_title: scope.moduleId ? "UUID-bound module" : "" }, cockpit: null, actor: { user_id: "person", role: "member", is_human: true }, has_meeting_workflows: false, has_stable_bindings: true }));
  vi.mocked(api.searchCockpitScopes).mockImplementation(async (_wsId, kind) => ({ workspace_id: "ws-1", project_id: kind === "modules" ? "p1" : null,
    items: [{ id: kind === "modules" ? "m1" : "p1", title: kind === "modules" ? "UUID-bound module" : "Existing project", project_id: kind === "modules" ? "p1" : null }], total: 1, next_cursor: null }));
});

describe("node binding with bounded selectors", () => {
  it("reads the authoritative bound project title without loading a project or module catalog", () => {
    setup({ ...projectNode, name: "Historical row name" });
    expect(screen.getByText("Existing project")).toBeVisible(); expect(screen.queryByText("Historical row name")).toBeNull();
    expect(api.searchCockpitScopes).not.toHaveBeenCalled(); expect(api.getCockpitContext).not.toHaveBeenCalled();
  });

  it("makes a missing module actionable without guessing a mapping from the row code", async () => {
    const { onOpenNode } = setup(taskNode); await userEvent.click(screen.getByRole("button", { name: "Configure parent binding" }));
    expect(onOpenNode).toHaveBeenCalledWith("module-row"); expect(screen.queryByText("UUID-bound module")).toBeNull();
  });

  it("keeps the chosen UUID mapping after a rejected save and closes only after its confirmed retry", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("Module already mapped")).mockResolvedValueOnce(undefined); setup(moduleNode, save); const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Configure binding" })); await user.click(screen.getByRole("button", { name: "Module" }));
    await user.click(await screen.findByRole("button", { name: "UUID-bound module" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save binding" })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Save binding" })); expect(await screen.findByRole("alert")).toHaveTextContent("Module already mapped");
    expect(screen.getByRole("button", { name: "Module" })).toHaveTextContent("UUID-bound module"); expect(save).toHaveBeenLastCalledWith({ project_id: "p1", module_id: "m1" });
    await user.click(screen.getByRole("button", { name: "Save binding" })); await waitFor(() => expect(screen.queryByRole("button", { name: "Save binding" })).toBeNull()); expect(save).toHaveBeenCalledTimes(2);
  });

  it.each([projectNode, taskNode])("allows explicit structural configuration without a depth convention for $id", async (node) => {
    setup(node); await userEvent.click(screen.getByRole("button", { name: "Configure binding" })); expect(screen.getByRole("button", { name: "Module" })).toBeVisible();
  });

  it("offers a real module-creation destination when the requested project's server page is empty", async () => {
    vi.mocked(api.searchCockpitScopes).mockResolvedValue({ workspace_id: "ws-1", project_id: "p1", items: [], total: 0, next_cursor: null });
    setup(moduleNode); await userEvent.click(screen.getByRole("button", { name: "Configure binding" })); await userEvent.click(screen.getByRole("button", { name: "Module" }));
    const link = await screen.findByRole("link", { name: "Open project in a new tab" }); expect(link).toHaveAttribute("href", "/ws/projects/p1"); expect(link).toHaveAttribute("target", "_blank");
  });

  it("keeps a bound module intact when loading candidate modules fails, and exposes retry", async () => {
    vi.mocked(api.searchCockpitScopes).mockRejectedValue(new Error("offline"));
    setup({ ...moduleNode, project_id: "p1", module_id: "m1" }, undefined, binding({ source_node_id: "module-row", module_id: "m1", module_title: "UUID-bound module" }));
    await userEvent.click(screen.getByRole("button", { name: "Configure binding" })); await userEvent.click(screen.getByRole("button", { name: "Module" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load modules"); expect(screen.getByText(/Existing project \/ UUID-bound module/)).toBeVisible();
    const calls = vi.mocked(api.searchCockpitScopes).mock.calls.length; await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(vi.mocked(api.searchCockpitScopes).mock.calls.length).toBe(calls + 1));
  });
});
