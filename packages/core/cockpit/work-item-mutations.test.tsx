// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { CockpitBoardSchema } from "../api/schemas";
import { cockpitKeys } from "./queries";
import { cockpitReadKeys as readKeys } from "./read-queries";
import { useCreateCockpitWorkItem, useDeleteCockpitWorkItem, useMoveCockpitWorkItem, useRenameCockpitWorkItem } from "./mutations";
import { CockpitStatusNotInWorkflowError } from "./write-errors";

vi.mock("../api", () => ({ api: {
  createCockpitWorkItem: vi.fn(), updateCockpitNode: vi.fn(), moveCockpitWorkItem: vi.fn(), deleteCockpitNode: vi.fn(),
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

  it("renames optimistically and rolls back when the server refuses", async () => {
    const { wrapper, cached } = setup();
    vi.mocked(api.updateCockpitNode).mockRejectedValue(Object.assign(new Error("refused"), { status: 400, body: { error: "codes are fixed" } }));
    const { result, unmount } = renderHook(() => useRenameCockpitWorkItem("ws-1"), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ id: "w1", name: "新名称" })).rejects.toThrow("codes are fixed");
    });
    expect(cached().nodes[0]?.name).toBe("旧名称");
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
    try {
      await result.current.mutateAsync({ id: "w1", parent_id: "m2" });
    } catch (error) {
      expect((error as CockpitStatusNotInWorkflowError).detail).toMatchObject({ issue: "TES-3", workflow_name: "受限", allowed_statuses: ["backlog", "done"] });
    }
    unmount();
  });
});
