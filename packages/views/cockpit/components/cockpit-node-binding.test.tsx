import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { CockpitNodeSchema } from "@multica/core/api/schemas";
import type { CockpitNode, Module } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitNodeBindingField } from "./cockpit-node-binding";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/api", () => ({ api: { listProjects: vi.fn() } }));
import { api } from "@multica/core/api";

const projectNode = CockpitNodeSchema.parse({ id: "project-row", name: "Project", project_id: "p1" });
const moduleNode = CockpitNodeSchema.parse({ id: "module-row", parent_id: "project-row", name: "Module" });
const taskNode = CockpitNodeSchema.parse({ id: "task-row", parent_id: "module-row", code: "01.01.01" });
const modules = [{ id: "m1", project_id: "p1", title: "UUID-bound module" }] as Module[];

function setup(node: CockpitNode, onSave = vi.fn().mockResolvedValue(undefined), overrides: Partial<React.ComponentProps<typeof CockpitNodeBindingField>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenNode = vi.fn();
  render(<QueryClientProvider client={client}>
    <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>
      <CockpitNodeBindingField node={node} nodes={new Map([projectNode, moduleNode, taskNode].map((n) => [n.id, n]))}
        modules={modules} onSave={onSave} onOpenNode={onOpenNode} {...overrides} />
    </I18nProvider>
  </QueryClientProvider>);
  return { onSave, onOpenNode };
}

describe("node binding configuration", () => {
  beforeEach(() => {
    vi.mocked(api.listProjects).mockResolvedValue({ projects: [{ id: "p1", title: "Existing project" }], total: 1 } as Awaited<ReturnType<typeof api.listProjects>>);
  });

  it("makes an unbound execution item's missing module actionable without guessing from its code", async () => {
    const { onOpenNode } = setup(taskNode);
    await userEvent.click(screen.getByRole("button", { name: "Configure parent binding" }));
    expect(onOpenNode).toHaveBeenCalledWith("module-row");
    expect(screen.queryByText("UUID-bound module")).toBeNull();
  });

  it("keeps the chosen UUID mapping and form open after a rejected save, then retries", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("Module already mapped")).mockResolvedValueOnce(undefined);
    setup(moduleNode, save);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Configure binding" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Project" })).not.toBeDisabled());
    await user.click(screen.getByRole("combobox", { name: "Module" }));
    await user.click(await screen.findByRole("option", { name: "UUID-bound module" }));
    await user.click(screen.getByRole("button", { name: "Save binding" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Module already mapped");
    expect(screen.getByRole("combobox", { name: "Module" })).toHaveTextContent("UUID-bound module");
    expect(save).toHaveBeenLastCalledWith({ project_id: "p1", module_id: "m1" });
    await user.click(screen.getByRole("button", { name: "Save binding" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save binding" })).toBeNull());
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("shows the bound project's title instead of the historical node name and allows a root-level module", async () => {
    setup({ ...projectNode, name: "Historical row name" });
    expect(await screen.findByText("Existing project")).toBeTruthy();
    expect(screen.queryByText("Historical row name")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Configure binding" }));
    expect(screen.getByRole("combobox", { name: "Module" })).toBeTruthy();
  });

  it("allows an explicitly chosen structural mapping on a deep empty row without using depth or code", async () => {
    setup(taskNode);
    await userEvent.click(screen.getByRole("button", { name: "Configure binding" }));
    expect(screen.getByRole("combobox", { name: "Module" })).toBeTruthy();
  });

  it("distinguishes a module request failure from invalid binding and exposes retry", async () => {
    const retry = vi.fn();
    setup({ ...moduleNode, project_id: "p1", module_id: "m1" }, undefined, {
      modules: [], modulesError: true, onRetryModules: retry,
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load modules");
    expect(screen.queryByText("The binding cannot be resolved. Check its parent and mapped module.")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
