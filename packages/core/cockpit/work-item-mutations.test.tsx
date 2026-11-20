// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { CockpitBoardSchema } from "../api/schemas";
import { cockpitKeys } from "./queries";
import { cockpitReadKeys } from "./read-queries";
import { cockpitReadKeys as readKeys } from "./read-queries";
import { useCreateCockpitWorkItem, useDeleteCockpitWorkItem, useMoveCockpitWorkItem, useRenameCockpitWorkItem, useRenumberCockpitChildren, useReconcileCockpitPlan } from "./mutations";
import { CockpitStatusNotInWorkflowError, isCockpitReconcileAlreadyApplied, CockpitPlanWriteRefusedError } from "./write-errors";

vi.mock("../api", () => ({ api: {
  createCockpitWorkItem: vi.fn(), updateCockpitNode: vi.fn(), moveCockpitWorkItem: vi.fn(), deleteCockpitNode: vi.fn(),
  renumberCockpitChildren: vi.fn(), reconcileCockpitPlan: vi.fn(),
} }));
afterEach(cleanup);

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const board = CockpitBoardSchema.parse({ cockpit: { id: "cp" }, nodes: [{ id: "w1", name: "旧名称", code: "01.01.01" }] });
  client.setQueryData(cockpitKeys.board("ws-1"), board);
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const cached = () => client.getQueryData<ReturnType<typeof CockpitBoardSchema.parse>>(cockpitKeys.board("ws-1"))!;
  return { client, board, wrapper: Wrapper, cached };
}

describe("work-item mutations (S4)", () => {
  it("inserts the created row and refreshes the plan", async () => {
    const { client, wrapper, cached } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    vi.mocked(api.createCockpitWorkItem).mockResolvedValue({ id: "w2", name: "新工作项", code: "01.01.02", replayed: false } as never);
    const { result, unmount } = renderHook(() => useCreateCockpitWorkItem("ws-1"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ module_id: "m1", name: "新工作项" }); });
    expect(api.createCockpitWorkItem).toHaveBeenCalledWith({ module_id: "m1", name: "新工作项" }, "ws-1");
    expect(cached().nodes.map((n) => n.id)).toContain("w2");
    expect(invalidate.mock.calls.some(([arg]) => JSON.stringify(arg?.queryKey) === JSON.stringify(readKeys.all("ws-1")))).toBe(true);
    unmount();
  });

  it("renames optimistically on the plan cache and rolls it back when the server refuses", async () => {
    const { client, wrapper } = setup();
    const planKey = cockpitReadKeys.plan("ws-1", { projectId: null, moduleId: null });
    const plan = { nodes: [{ id: "w1", name: "旧名称", code: "01.01.01", tasks: null }] };
    client.setQueryData(planKey, plan);
    vi.mocked(api.updateCockpitNode).mockRejectedValue(Object.assign(new Error("refused"), { status: 400, body: { error: "codes are fixed" } }));
    const { result, unmount } = renderHook(() => useRenameCockpitWorkItem("ws-1"), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ id: "w1", name: "新名称" })).rejects.toThrow("codes are fixed");
    });
    expect(client.getQueryData<{ nodes: Array<{ id: string; name: string }> }>(planKey)?.nodes[0]?.name).toBe("旧名称");
    unmount();
  });

  it("refuses to confirm a rename whose response does not name the row", async () => {
    const { client, wrapper } = setup();
    const planKey = cockpitReadKeys.plan("ws-1", { projectId: null, moduleId: null });
    client.setQueryData(planKey, { nodes: [{ id: "w1", name: "旧名称" }] });
    vi.mocked(api.updateCockpitNode).mockResolvedValue({ id: "", name: "新名称" } as never);
    const { result, unmount } = renderHook(() => useRenameCockpitWorkItem("ws-1"), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ id: "w1", name: "新名称" })).rejects.toThrow("cockpit_write_not_confirmed");
    });
    expect(client.getQueryData<{ nodes: Array<{ name: string }> }>(planKey)?.nodes[0]?.name).toBe("旧名称");
    unmount();
  });

  it("invalidates the plan after a renumber", async () => {
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    vi.mocked(api.renumberCockpitChildren).mockResolvedValue({ id: "m1", changed: 3 } as never);
    const { result, unmount } = renderHook(() => useRenumberCockpitChildren("ws-1"), { wrapper });
    await act(async () => { await result.current.mutateAsync("m1"); });
    expect(invalidate.mock.calls.some(([arg]) => JSON.stringify(arg?.queryKey).includes("surfaces"))).toBe(true);
    unmount();
  });

  it("tells a refused second apply (409) from a bad request (400) on the reconcile", async () => {
    const { wrapper } = setup();
    vi.mocked(api.reconcileCockpitPlan).mockRejectedValue(Object.assign(new Error("conflict"), { status: 409, body: { error: "this board's plan was already reconciled" } }));
    const { result, unmount } = renderHook(() => useReconcileCockpitPlan("ws-1"), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ apply: true })).rejects.toSatisfy((error: unknown) => isCockpitReconcileAlreadyApplied(error));
    });
    vi.mocked(api.reconcileCockpitPlan).mockRejectedValue(Object.assign(new Error("bad"), { status: 400, body: { error: "the plan has not been reconciled yet" } }));
    await act(async () => {
      await expect(result.current.mutateAsync({ apply: true })).rejects.toSatisfy((error: unknown) =>
        error instanceof CockpitPlanWriteRefusedError && !isCockpitReconcileAlreadyApplied(error) && error.status === 400
        && error.message === "the plan has not been reconciled yet");
    });
    unmount();
  });

  it("deletes only after the server confirms", async () => {
    const { wrapper, cached } = setup();
    vi.mocked(api.deleteCockpitNode).mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403, body: { error: "this work item still files issues" } }));
    const { result, unmount } = renderHook(() => useDeleteCockpitWorkItem("ws-1"), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync("w1")).rejects.toThrow("this work item still files issues");
    });
    expect(cached().nodes.map((n) => n.id)).toContain("w1");
    vi.mocked(api.deleteCockpitNode).mockResolvedValue(undefined as never);
    await act(async () => { await result.current.mutateAsync("w1"); });
    expect(cached().nodes.map((n) => n.id)).not.toContain("w1");
    unmount();
  });

  it("surfaces a status refusal as a typed error carrying the issue and allowed statuses", async () => {
    const { wrapper } = setup();
    vi.mocked(api.moveCockpitWorkItem).mockRejectedValue(Object.assign(new Error("bad request"), { status: 400, body: {
      error: "TES-3: status \"todo\" is not part of this project's workflow \"受限\"",
      code: "status_not_in_workflow", workflow_name: "受限", allowed_statuses: ["backlog", "done"], issue: "TES-3",
    } }));
    const { result, unmount } = renderHook(() => useMoveCockpitWorkItem("ws-1"), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ id: "w1", parent_id: "m2" })).rejects.toBeInstanceOf(CockpitStatusNotInWorkflowError);
    });
    await act(async () => {
      await expect(result.current.mutateAsync({ id: "w1", parent_id: "m2" })).rejects.toMatchObject({
        detail: { issue: "TES-3", workflow_name: "受限", allowed_statuses: ["backlog", "done"] },
      });
    });
    unmount();
  });
});
