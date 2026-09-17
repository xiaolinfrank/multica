/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import type { ListModulesResponse, Module } from "../types";
import { issueKeys } from "../issues/queries";
import {
  useCreateModule,
  useDeleteModule,
  useReorderModules,
  useUpdateModule,
} from "./mutations";
import { moduleKeys } from "./queries";

vi.mock("../hooks", () => ({ useWorkspaceId: () => "ws-1" }));

function module(overrides: Partial<Module> & { id: string }): Module {
  return {
    workspace_id: "ws-1",
    project_id: "p-1",
    title: overrides.id,
    description: null,
    position: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    issue_count: 0,
    done_count: 0,
    ...overrides,
  };
}

function list(modules: Module[]): ListModulesResponse {
  return { modules, total: modules.length };
}

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function createClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function cached(qc: QueryClient) {
  return qc.getQueryData<ListModulesResponse>(moduleKeys.list("ws-1"));
}

describe("module mutations", () => {
  afterEach(() => vi.restoreAllMocks());

  it("appends a created module and skips a row the cache already holds", async () => {
    const qc = createClient();
    const first = module({ id: "m-1", position: 0 });
    qc.setQueryData(moduleKeys.list("ws-1"), list([first]));
    const created = module({ id: "m-2", position: 1, title: "Billing" });
    setApiInstance({
      createModule: vi.fn(async () => created),
    } as unknown as ApiClient);

    const { result } = renderHook(() => useCreateModule(), { wrapper: wrapper(qc) });
    act(() => result.current.mutate({ project_id: "p-1", title: "Billing" }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(cached(qc)?.modules.map((m) => m.id)).toEqual(["m-1", "m-2"]);
    expect(cached(qc)?.total).toBe(2);
  });

  it("rolls an optimistic rename back when the server rejects it", async () => {
    const qc = createClient();
    qc.setQueryData(moduleKeys.list("ws-1"), list([module({ id: "m-1", title: "Auth" })]));
    setApiInstance({
      updateModule: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as unknown as ApiClient);

    const { result } = renderHook(() => useUpdateModule(), { wrapper: wrapper(qc) });
    act(() => result.current.mutate({ id: "m-1", title: "Renamed" }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(cached(qc)?.modules[0]?.title).toBe("Auth");
  });

  it("removes the row only after the server confirms the delete", async () => {
    const qc = createClient();
    qc.setQueryData(moduleKeys.list("ws-1"), list([module({ id: "m-1" })]));
    let resolveDelete!: () => void;
    const deleteModule = vi.fn(async () => {
      await new Promise<void>((done) => {
        resolveDelete = done;
      });
    });
    setApiInstance({ deleteModule } as unknown as ApiClient);

    const { result } = renderHook(() => useDeleteModule(), { wrapper: wrapper(qc) });
    act(() => result.current.mutate("m-1"));
    await waitFor(() => expect(deleteModule).toHaveBeenCalledWith("m-1"));
    // While the request is in flight the row stays: delete is never optimistic.
    expect(cached(qc)?.modules.map((m) => m.id)).toEqual(["m-1"]);

    await act(async () => {
      resolveDelete();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(cached(qc)?.modules).toEqual([]);
    expect(cached(qc)?.total).toBe(0);
  });

  // The server nulls module_id on the module's issues in the same
  // transaction; those rows live in the issue caches, and a self-initiated
  // delete gets no module:deleted echo back to this client.
  it("invalidates issue caches once the server confirms the delete", async () => {
    const qc = createClient();
    qc.setQueryData(moduleKeys.list("ws-1"), list([module({ id: "m-1" })]));
    setApiInstance({ deleteModule: vi.fn(async () => {}) } as unknown as ApiClient);
    const invalidate = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => useDeleteModule(), { wrapper: wrapper(qc) });
    act(() => result.current.mutate("m-1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: issueKeys.all("ws-1") }),
    );
  });

  it("optimistically reorders by the given ids and keeps the settled order", async () => {
    const qc = createClient();
    const a = module({ id: "m-1", position: 0, created_at: "2026-01-01T00:00:00Z" });
    const b = module({ id: "m-2", position: 1, created_at: "2026-01-02T00:00:00Z" });
    qc.setQueryData(moduleKeys.list("ws-1"), list([a, b]));
    const reorderModules = vi.fn(async () => list([]));
    setApiInstance({ reorderModules } as unknown as ApiClient);

    const { result } = renderHook(() => useReorderModules(), { wrapper: wrapper(qc) });
    act(() => result.current.mutate(["m-2", "m-1"]));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(reorderModules).toHaveBeenCalledWith(["m-2", "m-1"]);
    expect(cached(qc)?.modules.map((m) => [m.id, m.position])).toEqual([
      ["m-2", 0],
      ["m-1", 1],
    ]);
  });

  it("rolls a failed reorder back to the snapshot", async () => {
    const qc = createClient();
    const a = module({ id: "m-1", position: 0, created_at: "2026-01-01T00:00:00Z" });
    const b = module({ id: "m-2", position: 1, created_at: "2026-01-02T00:00:00Z" });
    qc.setQueryData(moduleKeys.list("ws-1"), list([a, b]));
    setApiInstance({
      reorderModules: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as unknown as ApiClient);

    const { result } = renderHook(() => useReorderModules(), { wrapper: wrapper(qc) });
    act(() => result.current.mutate(["m-2", "m-1"]));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(cached(qc)?.modules.map((m) => [m.id, m.position])).toEqual([
      ["m-1", 0],
      ["m-2", 1],
    ]);
  });
});
