// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { applyCockpitSavedView, captureCockpitSavedView, cockpitMeetingSavedViewKey, cockpitSavedViewPath } from "./saved-views";
import { cockpitScopeViewKey, useCockpitScopeViewStore } from "./scope-view-store";
import { useCockpitDashboardViewStore } from "./dashboard-view-store";
const projectId = "10000000-0000-4000-8000-000000000001", moduleId = "10000000-0000-4000-8000-000000000002", rootId = "10000000-0000-4000-8000-000000000003";
const scope = { projectId, moduleId }, key = cockpitScopeViewKey("workspace", scope);
beforeEach(() => { useCockpitScopeViewStore.getState().reset(); useCockpitDashboardViewStore.getState().reset(); });
describe("personal cockpit view definitions", () => {
  it("captures only implemented settings and does not save navigation positions or selected objects", () => {
    useCockpitScopeViewStore.getState().updatePlan(key, { query: "approved work", rootIds: [rootId], collapsedIds: [rootId], zoom: "week", showFinance: true, scrollTop: 800, scrollLeft: 300, seeded: true });
    const search = new URLSearchParams({ tab: "plan", plan_view: "finance", project: projectId, module: moduleId }); const captured = captureCockpitSavedView("workspace", search);
    expect(captured).toEqual({ surface: "plan", scope, view: "finance", query: "approved work", rootIds: [rootId], zoom: "week", showFinance: true, toolsOpen: true });
    search.set("node", rootId); expect(captureCockpitSavedView("workspace", search)).toBeNull(); search.delete("node"); search.set("tab", "artifacts"); expect(captureCockpitSavedView("workspace", search)).toBeNull();
  });
  it("restores meeting filters and calendar window from the first page without reviving a day selection", () => {
    const meetingKey = cockpitMeetingSavedViewKey("workspace", scope);
    useCockpitScopeViewStore.getState().updateMeeting(meetingKey, { view: "month", query: "review", anchorDay: "2026-10-10", from: "2026-10-01", to: "2026-10-31", parties: ["Team"], only: ["links"], selectedDay: "2026-10-15" });
    useCockpitScopeViewStore.getState().updateMeeting(meetingKey, { cursors: ["", "opaque-page"], scrollTop: 700 });
    const view = captureCockpitSavedView("workspace", new URLSearchParams({ tab: "meetings", project: projectId, module: moduleId })); if (!view) throw new Error("Expected a supported view");
    applyCockpitSavedView("workspace", view);
    expect(useCockpitScopeViewStore.getState().meetings[meetingKey]).toMatchObject({ view: "month", query: "review", from: "2026-10-01", to: "2026-10-31", parties: ["Team"], selectedDay: null, cursors: [""], scrollTop: 0 });
    expect(cockpitSavedViewPath("/space/cockpit", view)).toBe(`/space/cockpit?tab=meetings&project=${projectId}&module=${moduleId}&from=2026-10-01&to=2026-10-31`);
    expect(JSON.stringify(view)).not.toMatch(/opaque-page|selectedDay|scrollTop/);
  });
  it("refuses invalid or object-related scopes rather than silently broadening them", () => {
    expect(captureCockpitSavedView("workspace", new URLSearchParams({ module: moduleId }))).toBeNull();
    expect(captureCockpitSavedView("workspace", new URLSearchParams({ tab: "meetings", meeting_node: rootId }))).toBeNull();
    expect(captureCockpitSavedView("workspace", new URLSearchParams({ tab: "governance", governance_view: "automation" }))).toBeNull();
  });
});
