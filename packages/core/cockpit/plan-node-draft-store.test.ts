// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { clearCockpitPlanNodeDraft, EMPTY_COCKPIT_PLAN_NODE_DRAFT, rejectCockpitPlanNodeDraft, updateCockpitPlanNodeDraft, useCockpitPlanNodeDraftStore } from "./plan-node-draft-store";
const key = JSON.stringify(["workspace", null, null]);
const command = { creation_key: "10000000-0000-4000-8000-000000000001", auto_code: true as const, name: "Project A", parent_id: null, project_id: "project", module_id: null, status: "" };
beforeEach(() => useCockpitPlanNodeDraftStore.getState().clearDraft());
describe("plan node command draft", () => {
  it("keeps the exact creation command after an unknown result, including a later unclassified conflict", () => {
    updateCockpitPlanNodeDraft(key, { ...EMPTY_COCKPIT_PLAN_NODE_DRAFT, name: "Project A", pending: command });
    rejectCockpitPlanNodeDraft(key, command, false); rejectCockpitPlanNodeDraft(key, command, true);
    expect(useCockpitPlanNodeDraftStore.getState().draft.byScope[key]).toMatchObject({ pending: command, uncertain: true });
  });
  it("does not revive a signed-out draft or clear newer user intent after a late response", () => {
    const before = { ...EMPTY_COCKPIT_PLAN_NODE_DRAFT, pending: command };
    updateCockpitPlanNodeDraft(key, before); useCockpitPlanNodeDraftStore.getState().clearDraft(); rejectCockpitPlanNodeDraft(key, command, false);
    expect(useCockpitPlanNodeDraftStore.getState().draft.byScope).toEqual({});
    updateCockpitPlanNodeDraft(key, { name: "Another project" }); clearCockpitPlanNodeDraft(key, before);
    expect(useCockpitPlanNodeDraftStore.getState().draft.byScope[key]?.name).toBe("Another project");
  });
});
