// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { applyCockpitSavedView, captureCockpitSavedView, cockpitMeetingSavedViewKey, cockpitSavedViewPath, CockpitSavedViewDefinitionSchema } from "./saved-views";
import { cockpitScopeViewKey, useCockpitScopeViewStore } from "./scope-view-store";
import { cockpitMeetingContextPath } from "./navigation";
import { useCockpitDashboardViewStore } from "./dashboard-view-store";
const projectId = "10000000-0000-4000-8000-000000000001", moduleId = "10000000-0000-4000-8000-000000000002", rootId = "10000000-0000-4000-8000-000000000003";
const scope = { projectId, moduleId }, key = cockpitScopeViewKey("workspace", scope);
beforeEach(() => { useCockpitScopeViewStore.getState().reset(); useCockpitDashboardViewStore.getState().reset(); });
describe("personal cockpit view definitions", () => {
  it("captures only implemented settings and does not save navigation positions or selected objects", () => {
    useCockpitScopeViewStore.getState().updatePlan(key, { query: "approved work", rootIds: [rootId], collapsedIds: [rootId], zoom: "week", showFinance: true, scrollTop: 800, scrollLeft: 300, seeded: true });
    const search = new URLSearchParams({ tab: "plan", plan_view: "finance", project: projectId, module: moduleId }); const captured = captureCockpitSavedView("workspace", search);
    expect(captured).toEqual({ surface: "plan", scope, view: "finance", query: "approved work", rootIds: [rootId], zoom: "week", showFinance: true, toolsOpen: true, includeArchivedMeetings: false });
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
  it("restores explicit archive choices and keeps them through opening and closing a meeting", () => {
    const meetingKey = cockpitMeetingSavedViewKey("workspace", scope);
    useCockpitScopeViewStore.getState().updateMeeting(meetingKey, { archive: "archived", query: "closed period", from: "2026-10-01", to: "2026-10-31" });
    const captured = captureCockpitSavedView("workspace", new URLSearchParams({ tab: "meetings", project: projectId, module: moduleId }));
    if (!captured || captured.surface !== "meetings") throw new Error("Expected saved meeting view");
    expect(captured.archive).toBe("archived");
    const destination = cockpitSavedViewPath("/space/cockpit", captured), query = new URLSearchParams(destination.split("?")[1]);
    expect(query.get("meeting_archive")).toBe("archived");
    const opened = new URLSearchParams(cockpitMeetingContextPath("/space/cockpit", "meeting", scope, query, "agenda").split("?")[1]);
    const closed = new URLSearchParams(cockpitMeetingContextPath("/space/cockpit", null, scope, opened).split("?")[1]);
    expect(closed.get("meeting_archive")).toBe("archived"); expect(closed.get("from")).toBe("2026-10-01"); expect(closed.get("module")).toBe(moduleId);
    useCockpitScopeViewStore.getState().reset(); applyCockpitSavedView("workspace", captured);
    expect(useCockpitScopeViewStore.getState().meetings[meetingKey]).toMatchObject({ archive: "archived", query: "closed period", cursors: [""] });
    const { archive: _archive, ...legacy } = captured;
    const restored = CockpitSavedViewDefinitionSchema.parse(legacy); applyCockpitSavedView("workspace", restored);
    expect(useCockpitScopeViewStore.getState().meetings[meetingKey]?.archive).toBe("active");
    expect(new URLSearchParams(cockpitSavedViewPath("/space/cockpit", restored).split("?")[1]).has("meeting_archive")).toBe(false);
    expect(CockpitSavedViewDefinitionSchema.safeParse({ ...captured, archive: "unknown" }).success).toBe(false);
    useCockpitScopeViewStore.getState().updatePlan(key, { includeArchivedMeetings: true });
    const plan = captureCockpitSavedView("workspace", new URLSearchParams({ tab: "plan", project: projectId, module: moduleId }));
    if (!plan || plan.surface !== "plan") throw new Error("Expected plan view");
    useCockpitScopeViewStore.getState().reset(); applyCockpitSavedView("workspace", plan);
    expect(useCockpitScopeViewStore.getState().plans[key]?.includeArchivedMeetings).toBe(true);
  });
  it("refuses invalid or object-related scopes rather than silently broadening them", () => {
    expect(captureCockpitSavedView("workspace", new URLSearchParams({ module: moduleId }))).toBeNull();
    expect(captureCockpitSavedView("workspace", new URLSearchParams({ tab: "meetings", meeting_node: rootId }))).toBeNull();
    expect(captureCockpitSavedView("workspace", new URLSearchParams({ tab: "governance", governance_view: "automation" }))).toBeNull();
  });
});
