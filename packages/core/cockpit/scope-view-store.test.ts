// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { resetAllRegisteredDrafts } from "../drafts/cleanup-registry";
import { cockpitScopeViewKey, EMPTY_COCKPIT_MEETING_CONTEXT, useCockpitScopeViewStore } from "./scope-view-store";

beforeEach(() => useCockpitScopeViewStore.getState().reset());

describe("cockpit scope navigation", () => {
  it("keeps project and module navigation separate without changing the requested scope", () => {
    const project = cockpitScopeViewKey("workspace", { projectId: "project", moduleId: null });
    const module = cockpitScopeViewKey("workspace", { projectId: "project", moduleId: "module" });
    const other = cockpitScopeViewKey("other-workspace", { projectId: "project", moduleId: "module" });
    const store = useCockpitScopeViewStore.getState();
    store.updatePlan(project, { collapsedIds: ["direction"], scrollLeft: 530, zoom: "week" });
    store.updatePlan(module, { query: "release", scrollTop: 240 });
    store.updateMeeting(project, { view: "month", anchorDay: "2026-10-10" });
    expect(useCockpitScopeViewStore.getState().plans[project]).toMatchObject({ collapsedIds: ["direction"], scrollLeft: 530, zoom: "week", query: "" });
    expect(useCockpitScopeViewStore.getState().plans[module]).toMatchObject({ query: "release", scrollTop: 240, collapsedIds: [] });
    expect(useCockpitScopeViewStore.getState().plans[other]).toBeUndefined();
    expect(useCockpitScopeViewStore.getState().meetings[project]).toMatchObject({ view: "month", anchorDay: "2026-10-10" });
  });

  it.each(["query", "from", "to", "anchorDay", "view"] as const)("resets paging when %s changes and changes back, but keeps unchanged navigation", (field) => {
    const store = useCockpitScopeViewStore.getState();
    const key = cockpitScopeViewKey("workspace", { projectId: null, moduleId: null });
    store.updateMeeting(key, { cursorKey: "old", cursors: ["", "page-2"], scrollTop: 600 });
    const original = EMPTY_COCKPIT_MEETING_CONTEXT[field];
    const patch = field === "view" ? { view: "month" as const } : { [field]: "changed" };
    store.updateMeeting(key, patch);
    expect(useCockpitScopeViewStore.getState().meetings[key]).toMatchObject({ cursorKey: "", cursors: [""], scrollTop: 0 });
    store.updateMeeting(key, { [field]: original });
    expect(useCockpitScopeViewStore.getState().meetings[key]?.cursors).toEqual([""]);
    store.updateMeeting(key, { cursors: ["", "fresh-page-2"], scrollTop: 120 });
    store.updateMeeting(key, { [field]: original });
    expect(useCockpitScopeViewStore.getState().meetings[key]).toMatchObject({ cursors: ["", "fresh-page-2"], scrollTop: 120 });
  });

  it("clears all scope navigation on account cleanup and changes the pending unmount generation", () => {
    const store = useCockpitScopeViewStore.getState();
    store.updatePlan("private", { query: "private title" });
    store.updateMeeting("private", { cursors: ["", "actor-cursor"] });
    const generation = store.sessionGeneration;
    resetAllRegisteredDrafts();
    expect(useCockpitScopeViewStore.getState()).toMatchObject({ plans: {}, meetings: {}, sessionGeneration: generation + 1 });
  });

  it("compares multi-value meeting filters by value, preserving a page for unchanged choices and resetting real changes", () => {
    const store = useCockpitScopeViewStore.getState();
    store.updateMeeting("meeting-scope", { parties: ["Partner A"], only: ["links"] });
    store.updateMeeting("meeting-scope", { cursorKey: "same-filter", cursors: ["", "page-2"] });
    store.updateMeeting("meeting-scope", { parties: ["Partner A"], only: ["links"] });
    expect(useCockpitScopeViewStore.getState().meetings["meeting-scope"]?.cursors).toEqual(["", "page-2"]);
    store.updateMeeting("meeting-scope", { parties: ["Partner A", "Partner B"] });
    expect(useCockpitScopeViewStore.getState().meetings["meeting-scope"]?.cursors).toEqual([""]);
  });

  it("keeps artifact navigation independent and does not resurrect a cursor when search returns to an earlier value", () => {
    const store = useCockpitScopeViewStore.getState();
    store.updateArtifact("artifact-scope", { cursorKey: "all", cursors: ["", "page-2"], scrollTop: 900 });
    store.updateArtifact("artifact-scope", { query: "audit" });
    store.updateArtifact("artifact-scope", { query: "" });
    expect(useCockpitScopeViewStore.getState().artifacts["artifact-scope"]).toMatchObject({ cursors: [""], scrollTop: 0, cursorKey: "" });
    expect(useCockpitScopeViewStore.getState().meetings).toEqual({});
  });
});
