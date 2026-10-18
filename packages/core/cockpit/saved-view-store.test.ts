// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../types/storage";
import { COCKPIT_SAVED_VIEW_LIMIT, cockpitSavedViewStorageKey, createCockpitSavedViewStore } from "./saved-view-store";
import type { CockpitSavedViewDefinition } from "./saved-views";
const definition: CockpitSavedViewDefinition = { surface: "work", scope: { projectId: null, moduleId: null }, audience: "team", kind: "workflow", mode: "attention" };
function memory() { const values = new Map<string, string>(); const adapter: StorageAdapter = { getItem: (key) => values.get(key) ?? null, setItem: vi.fn((key, value) => { values.set(key, value); }), removeItem: (key) => { values.delete(key); } }; return { values, adapter }; }
const records = (store: ReturnType<typeof createCockpitSavedViewStore>, userId = "alice", wsId = "space") => store.getState().namespaces[cockpitSavedViewStorageKey(userId, wsId)]?.items ?? [];
describe("device-local saved cockpit views", () => {
  it("isolates user/workspace namespaces and retains preferences across memory reset without exposing the previous account", () => {
    const { adapter } = memory(); const store = createCockpitSavedViewStore(adapter); store.getState().load("alice", "workspace-a"); const saved = store.getState().save("alice", "workspace-a", "My reviews", definition);
    store.getState().load("bob", "workspace-a"); expect(records(store, "bob", "workspace-a")).toEqual([]);
    store.getState().save("alice", "workspace-a", "Second tab view", definition); expect(records(store, "alice", "workspace-a")).toHaveLength(2);
    store.getState().load("alice", "workspace-b"); expect(records(store, "alice", "workspace-b")).toEqual([]); store.getState().reset(); expect(store.getState().namespaces).toEqual({});
    expect(() => store.getState().remove("alice", "workspace-a", saved.id)).toThrow("not_loaded");
    store.getState().load("alice", "workspace-a"); expect(records(store, "alice", "workspace-a")[0]).toEqual(saved);
  });
  it("does not announce or expose a saved record when device storage rejects the write", () => {
    const { adapter } = memory(); const store = createCockpitSavedViewStore(adapter); store.getState().load("alice", "space");
    vi.mocked(adapter.setItem).mockImplementationOnce(() => { throw new Error("quota exceeded"); }); expect(() => store.getState().save("alice", "space", "Keep my input", definition)).toThrow("write"); expect(records(store)).toEqual([]);
    store.getState().save("alice", "space", "Keep my input", definition); expect(records(store)[0]?.name).toBe("Keep my input");
  });
  it("keeps unreadable persisted data intact instead of treating it as an empty writable collection", () => {
    const { adapter, values } = memory(); const key = cockpitSavedViewStorageKey("alice", "space"); values.set(key, '{"version":99,"items":[]}'); const store = createCockpitSavedViewStore(adapter); store.getState().load("alice", "space");
    expect(store.getState().namespaces[key]?.loadFailed).toBe(true); expect(() => store.getState().save("alice", "space", "Replacement", definition)).toThrow("not_loaded"); expect(values.get(key)).toBe('{"version":99,"items":[]}');
  });
  it("bounds local growth and preserves identity when explicitly replacing a view", () => {
    const { adapter } = memory(); const store = createCockpitSavedViewStore(adapter); store.getState().load("alice", "space");
    for (let i = 0; i < COCKPIT_SAVED_VIEW_LIMIT; i++) store.getState().save("alice", "space", `View ${i}`, definition);
    expect(() => store.getState().save("alice", "space", "Another", definition)).toThrow("limit"); expect(() => store.getState().save("alice", "space", "VIEW 0", definition)).toThrow("duplicate");
    const id = records(store)[0]!.id; store.getState().save("alice", "space", "Updated view", { ...definition, audience: "mine" }, id);
    expect(records(store)).toHaveLength(COCKPIT_SAVED_VIEW_LIMIT); expect(records(store)[0]).toMatchObject({ id, name: "Updated view", definition: { audience: "mine" } });
  });
});
