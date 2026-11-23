// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { setApiInstance, ApiError } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import { useDropMissingScope, useScopeExistence } from "./use-scope-existence";
import type { IssueScopeValue } from "./issue-scope-picker";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

const project = {
  id: "p1",
  workspace_id: "ws-1",
  title: "Programme",
  description: null,
  status: "active",
  priority: "medium",
  icon: null,
  color: null,
  lead_type: null,
  lead_id: null,
  start_date: null,
  due_date: null,
  collab_path: null,
  position: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function moduleRow(id: string, projectId: string) {
  return {
    id,
    workspace_id: "ws-1",
    project_id: projectId,
    title: "Docking",
    description: null,
    position: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    issue_count: 0,
    done_count: 0,
  };
}

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});

describe("useScopeExistence", () => {
  it("reads a module that sits under another project as unusable", async () => {
    setApiInstance({
      listProjects: async () => ({ projects: [project], total: 1 }),
      listModules: async () => ({ modules: [moduleRow("m1", "p2")], total: 1 }),
    } as unknown as ApiClient);
    const value: IssueScopeValue = { project_id: "p1", module_id: "m1", work_item_id: null };
    const { result } = renderHook(() => useScopeExistence(value), { wrapper });

    // m1 exists, but under p2 — the create would carry a pair the server
    // refuses, so for this filing the module is not usable.
    await waitFor(() => expect(result.current.moduleMissing).toBe(true));
  });

  it("does not reject a module for its project when no project is named", async () => {
    setApiInstance({
      listProjects: async () => ({ projects: [project], total: 1 }),
      listModules: async () => ({ modules: [moduleRow("m1", "p2")], total: 1 }),
    } as unknown as ApiClient);
    const value: IssueScopeValue = { project_id: null, module_id: "m1", work_item_id: null };
    const { result } = renderHook(() => useScopeExistence(value), { wrapper });

    // The server derives the project from the module in this state, so the
    // module only has to exist.
    await waitFor(() => expect(result.current.moduleMissing).toBe(false));
    expect(result.current.projectMissing).toBeNull();
  });
});

describe("useDropMissingScope", () => {
  it("drops only the work item when its row is gone, keeping project and module", async () => {
    setApiInstance({
      listProjects: async () => ({ projects: [project], total: 1 }),
      listModules: async () => ({ modules: [moduleRow("m1", "p1")], total: 1 }),
      getCockpitNodeDetail: async () => {
        throw new ApiError("not found", 404, "Not Found");
      },
    } as unknown as ApiClient);
    const drop = vi.fn();
    const value: IssueScopeValue = { project_id: "p1", module_id: "m1", work_item_id: "w1" };
    renderHook(() => useDropMissingScope(value, drop), { wrapper });

    await waitFor(() =>
      expect(drop).toHaveBeenCalledWith({
        project_id: "p1",
        module_id: "m1",
        work_item_id: null,
      }),
    );
  });

  it("drops nothing when the work item read fails in transit", async () => {
    setApiInstance({
      listProjects: async () => ({ projects: [project], total: 1 }),
      listModules: async () => ({ modules: [moduleRow("m1", "p1")], total: 1 }),
      getCockpitNodeDetail: async () => {
        throw new TypeError("fetch failed");
      },
    } as unknown as ApiClient);
    const drop = vi.fn();
    const value: IssueScopeValue = { project_id: "p1", module_id: "m1", work_item_id: "w1" };
    renderHook(() => useDropMissingScope(value, drop), { wrapper });

    // A blip is not a deletion. Wait until every read has settled, so the
    // assertion is about the answer rather than about the first render.
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(drop).not.toHaveBeenCalled();
  });
});
