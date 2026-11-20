// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_COCKPIT_PLAN_CONTEXT, useCockpitScopeViewStore } from "./scope-view-store";

describe("plan view context (S5)", () => {
  beforeEach(() => useCockpitScopeViewStore.getState().reset());

  it("remembers the include-closed switch per scope and defaults it off", () => {
    const key = '["ws","p1",null]';
    expect(useCockpitScopeViewStore.getState().plans[key]?.includeClosedProjects).toBeUndefined();
    expect(EMPTY_COCKPIT_PLAN_CONTEXT.includeClosedProjects).toBe(false);
    useCockpitScopeViewStore.getState().updatePlan(key, { includeClosedProjects: true });
    expect(useCockpitScopeViewStore.getState().plans[key]?.includeClosedProjects).toBe(true);
    // Another scope keeps its own value.
    expect(useCockpitScopeViewStore.getState().plans['["ws",null,null]']?.includeClosedProjects).toBeUndefined();
  });

  it("remembers collapsed rows, which is how the tree's expansion survives a view switch", () => {
    const key = '["ws","p1",null]';
    useCockpitScopeViewStore.getState().updatePlan(key, { collapsedIds: ["m1", "m2"] });
    expect(useCockpitScopeViewStore.getState().plans[key]?.collapsedIds).toEqual(["m1", "m2"]);
  });
});
