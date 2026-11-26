// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateProjectViewState, useProjectViewStore } from "./view-store";
import { setCurrentWorkspace } from "../../platform/workspace-storage";

const flush = () => new Promise((resolve) => queueMicrotask(() => resolve(null)));

// Node 25 ships a partial `localStorage` shim under jsdom that's missing
// `clear`/`removeItem`; replace it with a real in-memory Storage so persist
// can round-trip values.
beforeAll(() => {
  if (typeof globalThis.localStorage?.clear !== "function") {
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (k) => values.get(k) ?? null,
      key: (i) => Array.from(values.keys())[i] ?? null,
      removeItem: (k) => { values.delete(k); },
      setItem: (k, v) => { values.set(k, v); },
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  }
});

beforeEach(() => {
  localStorage.clear();
  useProjectViewStore.setState({ layout: "table", groupBy: "none" });
  setCurrentWorkspace(null, null);
});

afterEach(() => {
  setCurrentWorkspace(null, null);
});

describe("useProjectViewStore", () => {

  it("partialize persists view prefs (no actions) under the workspace-namespaced key", async () => {
    setCurrentWorkspace("acme", "ws_a");
    await flush();
    useProjectViewStore.getState().setLayout("board");
    useProjectViewStore.getState().setGroupBy("priority");

    const raw = localStorage.getItem("multica_projects_view:acme");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.state).sort()).toEqual([
      "filters",
      "groupBy",
      "hiddenColumns",
      "layout",
      "sortDirection",
      "sortField",
    ]);
    expect(parsed.state.layout).toBe("board");
    expect(parsed.state.groupBy).toBe("priority");
  });

  it("rehydrates a different saved layout on workspace switch", async () => {
    localStorage.setItem(
      "multica_projects_view:acme",
      JSON.stringify({ state: { layout: "board" }, version: 1 }),
    );
    localStorage.setItem(
      "multica_projects_view:beta",
      JSON.stringify({ state: { layout: "table" }, version: 1 }),
    );

    setCurrentWorkspace("acme", "ws_a");
    await flush();
    await flush();
    expect(useProjectViewStore.getState().layout).toBe("board");

    setCurrentWorkspace("beta", "ws_b");
    await flush();
    await flush();
    expect(useProjectViewStore.getState().layout).toBe("table");
  });

  it("resets to the table when switching to a workspace with no persisted value", async () => {
    localStorage.setItem(
      "multica_projects_view:acme",
      JSON.stringify({ state: { layout: "board" }, version: 1 }),
    );

    setCurrentWorkspace("acme", "ws_a");
    await flush();
    await flush();
    expect(useProjectViewStore.getState().layout).toBe("board");

    setCurrentWorkspace("beta", "ws_b");
    await flush();
    await flush();
    expect(useProjectViewStore.getState().layout).toBe("table");
    expect(localStorage.getItem("multica_projects_view:acme")).not.toBeNull();
  });

  it("opens a saved card view as the board and keeps a saved table as the table", async () => {
    localStorage.setItem(
      "multica_projects_view:acme",
      JSON.stringify({ state: { viewMode: "comfortable", hiddenColumns: [] }, version: 0 }),
    );
    localStorage.setItem(
      "multica_projects_view:beta",
      JSON.stringify({ state: { viewMode: "compact" }, version: 0 }),
    );

    setCurrentWorkspace("acme", "ws_a");
    await flush();
    await flush();
    const acme = useProjectViewStore.getState();
    expect(acme.layout).toBe("board");
    expect(acme.hiddenColumns).toEqual(["start_date"]);
    expect("viewMode" in acme).toBe(false);

    setCurrentWorkspace("beta", "ws_b");
    await flush();
    await flush();
    expect(useProjectViewStore.getState().layout).toBe("table");
  });
});

describe("migrateProjectViewState", () => {
  it("leaves current-version state alone", () => {
    const state = { layout: "board", hiddenColumns: [] };
    expect(migrateProjectViewState(state, 1)).toBe(state);
  });

  it("keeps the other saved prefs while mapping viewMode", () => {
    expect(
      migrateProjectViewState(
        { viewMode: "compact", sortField: "name", hiddenColumns: ["issues", "start_date"] },
        0,
      ),
    ).toEqual({ layout: "table", sortField: "name", hiddenColumns: ["issues", "start_date"] });
  });

  it("defaults the sort to status/asc", async () => {
    useProjectViewStore.setState({ sortField: "name", sortDirection: "desc" });

    setCurrentWorkspace("fresh", "ws_fresh");
    await flush();
    await flush();
    expect(useProjectViewStore.getState().sortField).toBe("status");
    expect(useProjectViewStore.getState().sortDirection).toBe("asc");
  });

  it("migrates v0's untouched 'created' default to status/asc and re-persists at v1", async () => {
    localStorage.setItem(
      "multica_projects_view:acme",
      JSON.stringify({
        state: {
          viewMode: "comfortable",
          sortField: "created",
          sortDirection: "desc",
          hiddenColumns: ["issues"],
          filters: { statuses: [], priorities: [], leads: [] },
        },
        version: 0,
      }),
    );

    setCurrentWorkspace("acme", "ws_a");
    await flush();
    await flush();
    expect(useProjectViewStore.getState().sortField).toBe("status");
    expect(useProjectViewStore.getState().sortDirection).toBe("asc");
    // The saved card view opens as the board; start date became a column
    // after these preferences were saved, so it starts hidden too.
    expect(useProjectViewStore.getState().layout).toBe("board");
    expect(useProjectViewStore.getState().hiddenColumns).toEqual(["issues", "start_date"]);

    const raw = JSON.parse(
      localStorage.getItem("multica_projects_view:acme") as string,
    );
    expect(raw.version).toBe(1);
    expect(raw.state.sortField).toBe("status");
  });

  it("keeps a deliberately chosen sort field through the v0 migration", async () => {
    localStorage.setItem(
      "multica_projects_view:acme",
      JSON.stringify({
        state: { sortField: "name", sortDirection: "asc" },
        version: 0,
      }),
    );
    localStorage.setItem(
      "multica_projects_view:beta",
      JSON.stringify({
        state: { sortField: "status", sortDirection: "desc" },
        version: 0,
      }),
    );
    // created+asc can only be a deliberate pick: choosing "created" resets
    // to desc, so the asc direction was flipped by hand.
    localStorage.setItem(
      "multica_projects_view:gamma",
      JSON.stringify({
        state: { sortField: "created", sortDirection: "asc" },
        version: 0,
      }),
    );

    setCurrentWorkspace("acme", "ws_a");
    await flush();
    await flush();
    expect(useProjectViewStore.getState().sortField).toBe("name");

    // A v0 user who already sorted by status keeps their flipped direction.
    setCurrentWorkspace("beta", "ws_b");
    await flush();
    await flush();
    expect(useProjectViewStore.getState().sortField).toBe("status");
    expect(useProjectViewStore.getState().sortDirection).toBe("desc");

    setCurrentWorkspace("gamma", "ws_g");
    await flush();
    await flush();
    expect(useProjectViewStore.getState().sortField).toBe("created");
    expect(useProjectViewStore.getState().sortDirection).toBe("asc");
  });
});
