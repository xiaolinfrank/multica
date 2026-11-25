// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// The persist namespace here is the storage wrapper's concern; use the real
// `localStorage` key so the test exercises an actual rehydrate.
vi.mock("../../platform/workspace-storage", () => ({
  createWorkspaceAwareStorage: (adapter: unknown) => adapter,
  registerForWorkspaceRehydration: () => {},
}));

import {
  DEFAULT_SIDEBAR_PROJECT_SETTINGS,
  useSidebarTreeStore,
} from "./sidebar-tree-store";

const STORAGE_KEY = "multica_sidebar_tree";
const LEGACY_DEFAULT_STATUSES = ["planned", "in_progress", "paused"];

function writePersisted(statuses: string[], version: number) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      state: {
        projectSettings: {
          ...DEFAULT_SIDEBAR_PROJECT_SETTINGS,
          statuses,
        },
      },
      version,
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  useSidebarTreeStore.setState({ expanded: [] });
});

describe("useSidebarTreeStore", () => {
  it("toggles expansion idempotently", () => {
    const store = useSidebarTreeStore.getState();
    store.setExpanded("project:p1", true);
    store.setExpanded("project:p1", true);
    expect(useSidebarTreeStore.getState().expanded).toEqual(["project:p1"]);
    store.setExpanded("project:p1", false);
    expect(useSidebarTreeStore.getState().expanded).toEqual([]);
  });

  it("collapses each section on its own", () => {
    useSidebarTreeStore.setState({ viewsCollapsed: false, pinnedCollapsed: false, projectsCollapsed: false });
    useSidebarTreeStore.getState().setPinnedCollapsed(true);
    const state = useSidebarTreeStore.getState();
    expect([state.viewsCollapsed, state.pinnedCollapsed, state.projectsCollapsed]).toEqual([false, true, false]);
    state.setViewsCollapsed(true);
    expect(useSidebarTreeStore.getState().viewsCollapsed).toBe(true);
  });
});

describe("sidebar project filter defaults", () => {
  it("lists in-progress projects only", () => {
    expect(DEFAULT_SIDEBAR_PROJECT_SETTINGS.statuses).toEqual(["in_progress"]);
  });

  it.each([
    [LEGACY_DEFAULT_STATUSES],
    [["paused", "planned", "in_progress"]],
  ])("migrates the untouched v0 default %j to in-progress only", async (statuses) => {
    writePersisted(statuses, 0);

    await useSidebarTreeStore.persist.rehydrate();

    expect(useSidebarTreeStore.getState().projectSettings.statuses).toEqual(["in_progress"]);
  });

  it("preserves a custom v0 status filter", async () => {
    writePersisted(["in_progress", "completed"], 0);

    await useSidebarTreeStore.persist.rehydrate();

    expect(useSidebarTreeStore.getState().projectSettings.statuses).toEqual([
      "in_progress",
      "completed",
    ]);
  });

  it("preserves the legacy set once it was written by a v1 client", async () => {
    writePersisted(LEGACY_DEFAULT_STATUSES, 1);

    await useSidebarTreeStore.persist.rehydrate();

    expect(useSidebarTreeStore.getState().projectSettings.statuses).toEqual(
      LEGACY_DEFAULT_STATUSES,
    );
  });
});
