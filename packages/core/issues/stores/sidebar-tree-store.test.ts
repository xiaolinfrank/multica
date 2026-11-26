// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCurrentWorkspace } from "../../platform/workspace-storage";
import {
  DEFAULT_SIDEBAR_INBOX_SETTINGS,
  DEFAULT_SIDEBAR_PROJECT_SETTINGS,
  useSidebarTreeStore,
} from "./sidebar-tree-store";

const STORAGE_KEY = "multica_sidebar_tree";
const LEGACY_DEFAULT_STATUSES = ["planned", "in_progress", "paused"];

/**
 * Write a persisted copy for `slug` and open that workspace, so rehydrate
 * reads the copy this test stored.
 */
async function writePersisted(statuses: string[], version: number, slug = "acme") {
  localStorage.setItem(
    `${STORAGE_KEY}:${slug}`,
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
  setCurrentWorkspace(slug, `ws-${slug}`);
  await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  useSidebarTreeStore.setState({ expanded: [], workingCollapsed: false, needsAttentionCollapsed: false });
});

afterEach(async () => {
  setCurrentWorkspace(null, null);
  await Promise.resolve();
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

  it("persists Team section collapse preferences separately for each workspace", async () => {
    setCurrentWorkspace("team-a", "ws-a");
    await Promise.resolve();
    useSidebarTreeStore.getState().setNeedsAttentionCollapsed(true);

    setCurrentWorkspace("team-b", "ws-b");
    await Promise.resolve();
    expect(useSidebarTreeStore.getState().needsAttentionCollapsed).toBe(false);
    useSidebarTreeStore.getState().setWorkingCollapsed(true);

    setCurrentWorkspace("team-a", "ws-a");
    await Promise.resolve();
    expect(useSidebarTreeStore.getState().needsAttentionCollapsed).toBe(true);
    expect(useSidebarTreeStore.getState().workingCollapsed).toBe(false);
    setCurrentWorkspace("team-b", "ws-b");
    await Promise.resolve();
    expect(useSidebarTreeStore.getState().workingCollapsed).toBe(true);
  });

  it("opens new Team sections by default when hydrating older sidebar preferences", async () => {
    localStorage.setItem("multica_sidebar_tree:legacy", JSON.stringify({
      state: { expanded: ["project:p1"], pinnedCollapsed: true },
      version: 0,
    }));
    setCurrentWorkspace("legacy", "ws-legacy");
    await Promise.resolve();
    const state = useSidebarTreeStore.getState();
    expect(state.expanded).toEqual(["project:p1"]);
    expect(state.pinnedCollapsed).toBe(true);
    expect(state.workingCollapsed).toBe(false);
    expect(state.needsAttentionCollapsed).toBe(false);
  });

  describe("compact Inbox rows", () => {
    async function open(slug: string, stored?: { state: unknown; version: number }) {
      if (stored) localStorage.setItem(`multica_sidebar_tree:${slug}`, JSON.stringify(stored));
      setCurrentWorkspace(slug, `ws-${slug}`);
      await Promise.resolve();
      return useSidebarTreeStore.getState().inboxSettings;
    }

    it("are on by default where nothing is stored yet", async () => {
      expect(DEFAULT_SIDEBAR_INBOX_SETTINGS.compact).toBe(true);
      expect((await open("fresh")).compact).toBe(true);
    });

    it("stay off for a copy stored while two-line rows were the default", async () => {
      const inboxSettings = await open("existing", {
        state: { inboxSettings: { limit: 10, showCount: false, railBadge: true, compact: false } },
        version: 2,
      });
      expect(inboxSettings).toEqual({ limit: 10, showCount: false, railBadge: true, compact: false });
    });

    it("stay off for a copy stored before the setting existed", async () => {
      const inboxSettings = await open("legacy", { state: { expanded: ["project:p1"] }, version: 0 });
      expect(inboxSettings).toEqual({ ...DEFAULT_SIDEBAR_INBOX_SETTINGS, compact: false });
    });

    it("go back off once for a copy that version 1 forced on", async () => {
      const inboxSettings = await open("forced", {
        state: { inboxSettings: { limit: 5, showCount: true, railBadge: true, compact: true } },
        version: 1,
      });
      expect(inboxSettings.compact).toBe(false);
    });

    it("keep a value the user picked", async () => {
      expect((await open("chosen-v0", {
        state: { inboxSettings: { limit: 5, showCount: true, railBadge: true, compact: true } },
        version: 0,
      })).compact).toBe(true);
      expect((await open("chosen-v2", {
        state: { inboxSettings: { limit: 5, showCount: true, railBadge: true, compact: true } },
        version: 2,
      })).compact).toBe(true);
      expect((await open("chosen-v3", {
        state: { inboxSettings: { limit: 5, showCount: true, railBadge: true, compact: false } },
        version: 3,
      })).compact).toBe(false);
    });

    it("save the kept value with the copy, so a later default leaves it alone", async () => {
      await open("saved", { state: { expanded: [] }, version: 0 });
      const saved = JSON.parse(localStorage.getItem("multica_sidebar_tree:saved")!);
      expect(saved.version).toBe(3);
      expect(saved.state.inboxSettings.compact).toBe(false);
    });
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
    await writePersisted(statuses, 0);

    await useSidebarTreeStore.persist.rehydrate();

    expect(useSidebarTreeStore.getState().projectSettings.statuses).toEqual(["in_progress"]);
  });

  it("preserves a custom v0 status filter", async () => {
    await writePersisted(["in_progress", "completed"], 0);

    await useSidebarTreeStore.persist.rehydrate();

    expect(useSidebarTreeStore.getState().projectSettings.statuses).toEqual([
      "in_progress",
      "completed",
    ]);
  });

  it("preserves the legacy set once it was written by a v1 client", async () => {
    await writePersisted(LEGACY_DEFAULT_STATUSES, 1);

    await useSidebarTreeStore.persist.rehydrate();

    expect(useSidebarTreeStore.getState().projectSettings.statuses).toEqual(
      LEGACY_DEFAULT_STATUSES,
    );
  });
});
