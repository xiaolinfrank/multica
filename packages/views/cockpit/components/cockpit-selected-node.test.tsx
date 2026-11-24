import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enCockpit from "../../locales/en/cockpit.json";
import enCommon from "../../locales/en/common.json";
import { CockpitSelectedNode } from "./cockpit-selected-node";

const runningTasks = [{ task_id: "t1", issue_id: "i1", issue_identifier: "TES-1", status: "running" }];
const conflict = { code: "running_agent_tasks", message: "running", runningTasks };

const state = vi.hoisted(() => ({
  ancestors: 1,
  updateMutate: vi.fn(),
  updateMutateAsync: vi.fn(),
  renameRow: vi.fn(),
  deleteNode: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => state.toastError(...args) },
}));

vi.mock("@multica/core/issues", async (original) => ({
  ...(await original<typeof import("@multica/core/issues")>()),
  containerOperationBasisOptions: () => ({ queryKey: ["test", "operation"], queryFn: async () => null }),
  containerOperationAllowed: () => true,
}));

vi.mock("@multica/core/cockpit", async (original) => {
  const actual = await original<typeof import("@multica/core/cockpit")>();
  return {
    ...actual,
    cockpitNodeDetailOptions: () => ({
      queryKey: ["test", "node"],
      queryFn: async () => ({
        node: {
          id: "n1", code: "01.01", name: "确权线", status: "", owner: "",
          project_id: "p1", module_id: "m1", parent_id: state.ancestors === 1 ? "p1" : "m1",
        },
        ancestors: state.ancestors === 1 ? [{ id: "p1" }] : [{ id: "p1" }, { id: "m1" }],
        children_count: 0,
        meetings: { total: 0 },
        actor: { is_human: true, user_id: "u1" },
        scope_match: true,
        binding: { project_id: "p1", module_id: "m1" },
      }),
    }),
    useUpdateCockpitNode: () => ({ mutate: state.updateMutate, mutateAsync: state.updateMutateAsync }),
    useDeleteCockpitNode: () => ({ mutateAsync: state.deleteNode }),
    cockpitObjectPath: () => "/ws/cockpit/node",
    cockpitNodeMeetingsPath: () => "/ws/cockpit/meetings",
  };
});

vi.mock("../../plan-tree/use-plan-row-rename", () => ({
  usePlanRowRename: () => state.renameRow,
}));

vi.mock("./use-cockpit-command-context", () => ({
  useCockpitCommandContext: () => () => true,
}));

vi.mock("../../navigation", () => ({
  useNavigation: () => ({ pathname: "/ws/cockpit", push: vi.fn(), searchParams: new URLSearchParams() }),
  AppLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock("./cockpit-node-panel", () => ({
  CockpitNodePanel: ({ onPatch }: { onPatch: (patch: Record<string, unknown>) => void }) => (
    <button type="button" onClick={() => onPatch({ name: "新名称" })}>rename row</button>
  ),
}));

vi.mock("./cockpit-directory-section", () => ({
  CockpitDirectorySection: () => null,
}));

vi.mock("./cockpit-node-tasks", () => ({ CockpitNodeTasks: () => null }));

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, common: enCommon } }}>
        <CockpitSelectedNode wsId="ws-1" nodeId="n1" scope={{ kind: "workspace" } as never} planView="gantt" section="details" onClose={() => {}} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.renameRow.mockReset();
  state.updateMutate.mockReset();
  state.updateMutateAsync.mockReset();
  state.deleteNode.mockReset();
  state.toastError.mockReset();
});

describe("CockpitSelectedNode rename", () => {
  it("retries a module rename with the refused name, not an empty one", async () => {
    state.ancestors = 1;
    state.renameRow.mockRejectedValueOnce(conflict).mockResolvedValueOnce(undefined);
    const { container } = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "rename row" }));

    await screen.findByText("An agent is working in this folder");
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(state.renameRow).toHaveBeenCalledTimes(2));
    expect(state.renameRow.mock.calls[0]).toEqual([expect.objectContaining({ kind: "module" }), "新名称", undefined]);
    expect(state.renameRow.mock.calls[1]).toEqual([expect.objectContaining({ kind: "module" }), "新名称", "force"]);
    expect(container.textContent).not.toContain(";");
  });

  it("retries a work item rename with the same name and the chosen mode", async () => {
    state.ancestors = 2;
    state.updateMutateAsync.mockRejectedValueOnce(conflict).mockResolvedValueOnce({ id: "n1", name: "新名称" });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "rename row" }));

    await screen.findByText("An agent is working in this folder");
    fireEvent.click(screen.getByRole("button", { name: "Sync later" }));
    await waitFor(() => expect(state.updateMutateAsync).toHaveBeenCalledTimes(2));
    expect(state.updateMutateAsync.mock.calls[0]![0]).toMatchObject({ id: "n1", patch: { name: "新名称" } });
    expect(state.updateMutateAsync.mock.calls[1]![0]).toMatchObject({ id: "n1", patch: { name: "新名称", directory_sync: "defer" } });
  });

  it("toasts the reason when a panel rename succeeds on the row but fails on disk", async () => {
    state.ancestors = 2;
    state.updateMutateAsync.mockResolvedValueOnce({
      id: "n1",
      name: "新名称",
      directory_sync: { status: "failed", reason: "target_exists", error: "a folder with the new name already exists" },
    });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "rename row" }));

    await waitFor(() => expect(state.toastError).toHaveBeenCalledTimes(1));
    expect(state.toastError.mock.calls[0]![0]).toContain("a folder with the new name already exists");
  });
});
