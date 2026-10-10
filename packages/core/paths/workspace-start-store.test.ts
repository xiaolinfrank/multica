// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => new Map<string, string>());
vi.mock("../platform/storage", () => ({ defaultStorage: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} }));
import { useWorkspaceStartStore } from "./workspace-start-store";
import { workspaceStartPath } from "./workspace-start";
beforeEach(() => { storage.clear(); useWorkspaceStartStore.setState({ page: "cockpit" }); });
describe("workspace entry device preference", () => {
  it("persists only the chosen page and restores it without changing workspace identity", async () => {
    useWorkspaceStartStore.getState().setPage("my-issues");
    const saved = storage.get("multica_workspace_start")!;
    expect(JSON.parse(saved).state).toEqual({ page: "my-issues" });
    useWorkspaceStartStore.setState({ page: "cockpit" }); storage.set("multica_workspace_start", saved);
    await useWorkspaceStartStore.persist.rehydrate();
    expect(workspaceStartPath("other workspace", useWorkspaceStartStore.getState().page)).toBe("/other%20workspace/my-issues");
  });
  it.each([null, {}, { page: "invalid" }, { page: "https://outside.example" }])("defaults invalid persisted data to cockpit: %j", async (state) => {
    storage.set("multica_workspace_start", JSON.stringify({ state, version: 0 }));
    await useWorkspaceStartStore.persist.rehydrate();
    expect(useWorkspaceStartStore.getState().page).toBe("cockpit");
  });
});
