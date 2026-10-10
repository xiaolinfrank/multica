// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { resetAllRegisteredDrafts } from "../drafts/cleanup-registry";
import { cockpitTaskViewKey, useCockpitTaskViewStore } from "./task-view-store";
import { EMPTY_COCKPIT_DASHBOARD_VIEW, useCockpitDashboardViewStore } from "./dashboard-view-store";

beforeEach(() => {
  useCockpitDashboardViewStore.getState().reset();
  useCockpitTaskViewStore.getState().reset();
});

describe("dashboard navigation context", () => {
  it("keeps workspace filters and section cursor stacks separate", () => {
    const store = useCockpitDashboardViewStore.getState();
    store.update("ws-a", { audience: "team" });
    store.update("ws-a", { scrollTop: 400 });
    store.setPage("ws-a", "attention", "a:team:day:25", ["", "a-page-2"]);
    store.setPage("ws-a", "meetings", "a:day:6", ["", "meeting-page-2"]);
    store.update("ws-b", { mode: "overview" });
    store.setPage("ws-b", "attention", "b:mine:day:25", ["", "b-page-2"]);
    expect(useCockpitDashboardViewStore.getState().views["ws-a"]).toMatchObject({ audience: "team", scrollTop: 400,
      pages: { attention: { cursors: ["", "a-page-2"] }, meetings: { cursors: ["", "meeting-page-2"] } } });
    expect(useCockpitDashboardViewStore.getState().views["ws-b"]).toMatchObject({ audience: "mine", pages: { attention: { cursors: ["", "b-page-2"] } } });
    expect(EMPTY_COCKPIT_DASHBOARD_VIEW.pages).toEqual({});
  });

  it.each(["audience", "kind"] as const)("discards stale cursors and scroll when %s changes, including changing back", (field) => {
    const store = useCockpitDashboardViewStore.getState();
    store.setPage("ws-a", "attention", "original", ["", "page-2"]);
    store.update("ws-a", { scrollTop: 900 });
    const original = useCockpitDashboardViewStore.getState().views["ws-a"]![field];
    const patch = field === "audience" ? { audience: "team" as const } : { [field]: "changed" };
    store.update("ws-a", patch);
    expect(useCockpitDashboardViewStore.getState().views["ws-a"]).toMatchObject({ pages: {}, scrollTop: 0 });
    store.update("ws-a", { [field]: original });
    expect(useCockpitDashboardViewStore.getState().views["ws-a"]).toMatchObject({ pages: {}, scrollTop: 0 });
    store.setPage("ws-a", "attention", "original", ["", "new-page-2"]);
    store.update("ws-a", { [field]: original });
    expect(useCockpitDashboardViewStore.getState().views["ws-a"]?.pages.attention?.cursors).toEqual(["", "new-page-2"]);
  });

  it.each(["audience", "kind"] as const)("preserves execution and meeting positions when the %s queue filter changes", (field) => {
    const store = useCockpitDashboardViewStore.getState();
    store.setPage("ws-a", "attention-preview", "project-a:mine:8", ["", "preview-page-2"]);
    store.setPage("ws-a", "attention-full", "project-a:mine:25", ["", "full-page-2"]);
    store.setPage("ws-a", "execution", "project-a:6", ["", "execution-page-2"]);
    store.setPage("ws-a", "meetings", "project-a:day:6", ["", "meeting-page-2"]);
    store.update("ws-a", { scrollTop: 700 });
    const generation = useCockpitDashboardViewStore.getState().sessionGeneration;

    store.update("ws-a", field === "audience" ? { audience: "team" } : { kind: "workflow" });

    expect(useCockpitDashboardViewStore.getState().views["ws-a"]).toMatchObject({ scrollTop: 0, pages: {
      execution: { signature: "project-a:6", cursors: ["", "execution-page-2"] },
      meetings: { signature: "project-a:day:6", cursors: ["", "meeting-page-2"] },
    } });
    expect(Object.keys(useCockpitDashboardViewStore.getState().views["ws-a"]!.pages).sort()).toEqual(["execution", "meetings"]);
    expect(useCockpitDashboardViewStore.getState().sessionGeneration).toBe(generation);

  });

  it("clears the previous actor's navigation context through the registered session cleanup", () => {
    const dashboard = useCockpitDashboardViewStore.getState();
    dashboard.update("ws-a", { audience: "team", kind: "workflow", mode: "attention" });
    dashboard.update("ws-a", { scrollTop: 800 });
    dashboard.setPage("ws-a", "attention", "previous-actor-scope", ["", "previous-actor-cursor"]);
    dashboard.update("ws-b", { audience: "team" });
    const taskKey = cockpitTaskViewKey("ws-a", "node", "node-1");
    const tasks = useCockpitTaskViewStore.getState();
    tasks.update(taskKey, { text: "previous actor filter", category: "done" });
    tasks.update(taskKey, { cursorKey: "previous-actor-scope", cursors: ["", "previous-task-cursor"] });

    const generation = useCockpitDashboardViewStore.getState().sessionGeneration;
    resetAllRegisteredDrafts();

    expect(useCockpitDashboardViewStore.getState().sessionGeneration).toBe(generation + 1);
    expect(useCockpitDashboardViewStore.getState().views).toEqual({});
    expect(useCockpitTaskViewStore.getState().views).toEqual({});
    dashboard.update("ws-a", { mode: "attention" });
    expect(useCockpitDashboardViewStore.getState().views["ws-a"]).toEqual({ ...EMPTY_COCKPIT_DASHBOARD_VIEW, mode: "attention" });
  });

  it("preserves context when returning between overview and the full queue, without storing API facts", () => {
    const store = useCockpitDashboardViewStore.getState();
    store.update("ws-a", { mode: "attention", audience: "team", kind: "issue" });
    store.setPage("ws-a", "attention", "project-a:team:issue:day:25", ["", "page-2"]);
    store.update("ws-a", { scrollTop: 540 });
    store.update("ws-a", { mode: "overview" });
    store.update("ws-a", { mode: "attention" });
    expect(useCockpitDashboardViewStore.getState().views["ws-a"]).toEqual({ audience: "team", kind: "issue", mode: "attention", scrollTop: 540,
      pages: { attention: { signature: "project-a:team:issue:day:25", cursors: ["", "page-2"] } } });
    store.reset();
    expect(useCockpitDashboardViewStore.getState().views).toEqual({});
  });
});
