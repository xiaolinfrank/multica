// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import { cockpitKeys } from "./queries";
import { useCreateModule, useUpdateModule } from "../modules/mutations";
import { useUpdateProject } from "../projects/mutations";

vi.mock("../hooks", () => ({ useWorkspaceId: () => "ws-1" }));

// Plan rows for L1/L2 take their NAME from project.title / module.title
// (plan_surface_derived), so every path that can change those titles has to
// invalidate the plan surface. All three already do; pin it.

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}
function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}
afterEach(() => vi.restoreAllMocks());

describe("plan refresh after project/module writes (S5)", () => {
  it("renaming a module invalidates the plan surface", async () => {
    const qc = client();
    setApiInstance({ updateModule: vi.fn(async (_id, data) => data) } as unknown as ApiClient);
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useUpdateModule(), { wrapper: wrapper(qc) });
    act(() => result.current.mutate({ id: "m-1", title: "改名后的模块" }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: cockpitKeys.surfaces("ws-1") });
  });

  it("creating a module invalidates the plan surface (its L2 row is written on the next read)", async () => {
    const qc = client();
    setApiInstance({ createModule: vi.fn(async () => ({ id: "m-new", title: "新模块" })) } as unknown as ApiClient);
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useCreateModule(), { wrapper: wrapper(qc) });
    act(() => result.current.mutate({ project_id: "p-1", title: "新模块" }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: cockpitKeys.surfaces("ws-1") });
  });

  it("renaming a project invalidates the plan surface", async () => {
    const qc = client();
    setApiInstance({ updateProject: vi.fn(async (_id, data) => data) } as unknown as ApiClient);
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useUpdateProject(), { wrapper: wrapper(qc) });
    act(() => result.current.mutate({ id: "p-1", title: "改名后的项目" }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: cockpitKeys.surfaces("ws-1") });
  });
});
