import { z } from "zod";
import { cockpitShellDestination, cockpitSurfacePath, type CockpitScope } from "./navigation";
import { cockpitScopeViewKey, EMPTY_COCKPIT_GOVERNANCE_CONTEXT, EMPTY_COCKPIT_MEETING_CONTEXT, EMPTY_COCKPIT_PLAN_CONTEXT, useCockpitScopeViewStore } from "./scope-view-store";
import { EMPTY_COCKPIT_DASHBOARD_VIEW, useCockpitDashboardViewStore } from "./dashboard-view-store";
import { parseDay } from "./model";
import { COCKPIT_MEETING_ONLY_FLAGS } from "./meeting-search";

const text = z.string().max(2000);
const values = z.array(z.string().max(200)).max(100);
const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => Boolean(parseDay(value)));
const day = calendarDay.or(z.literal(""));
const scope = z.object({ projectId: z.string().uuid().nullable(), moduleId: z.string().uuid().nullable() }).refine((value) => !value.moduleId || Boolean(value.projectId));
const planView = z.enum(["gantt", "table", "responsibility", "milestones", "finance", "operations"]);
const meetingView = z.enum(["list", "month", "week", "agenda", "timeline"]);
/** These are implemented view settings only. Object selections, pages, scroll positions and server data are intentionally absent. */
export const CockpitSavedViewDefinitionSchema = z.discriminatedUnion("surface", [
  z.object({ surface: z.literal("work"), scope, audience: z.enum(["mine", "team"]), kind: z.enum(["", "workflow", "action", "nas", "issue"]), mode: z.enum(["overview", "attention"]) }),
  z.object({ surface: z.literal("plan"), scope, view: planView, query: text, zoom: z.enum(["month", "week"]), rootIds: z.array(z.string().uuid()).max(100), showFinance: z.boolean(), toolsOpen: z.boolean(), includeArchivedMeetings: z.boolean().default(false) }),
  z.object({ surface: z.literal("meetings"), scope, view: meetingView, archive: z.enum(["active", "archived", "all"]).default("active"), query: text, anchorDay: calendarDay.nullable(), from: day, to: day, tracks: values, kinds: values, statuses: values, parties: values, only: z.array(z.enum(COCKPIT_MEETING_ONLY_FLAGS)).max(4) }),
  z.object({ surface: z.literal("governance"), scope, query: text, status: z.enum(["pending", "decided", "all"]), qualityOpen: z.boolean() }),
]);
export type CockpitSavedViewDefinition = z.infer<typeof CockpitSavedViewDefinitionSchema>;

export function cockpitMeetingSavedViewKey(wsId: string, value: CockpitScope) {
  return JSON.stringify([cockpitScopeViewKey(wsId, value), "", []]);
}

/** Capture the latest client-owned settings at the moment Save is invoked. */
export function captureCockpitSavedView(wsId: string, search: { get: (name: string) => string | null }): CockpitSavedViewDefinition | null {
  if (search.get("node") || search.get("meeting") || search.get("artifact") || search.get("action") || search.get("report")) return null;
  const route = cockpitShellDestination(search); const key = cockpitScopeViewKey(wsId, route.scope); const state = useCockpitScopeViewStore.getState();
  let candidate: unknown;
  if (route.surface === "work") {
    const view = useCockpitDashboardViewStore.getState().views[key] ?? EMPTY_COCKPIT_DASHBOARD_VIEW;
    candidate = { surface: "work", scope: route.scope, audience: view.audience, kind: view.kind, mode: view.mode };
  } else if (route.surface === "plan") {
    const view = state.plans[key] ?? EMPTY_COCKPIT_PLAN_CONTEXT;
    candidate = { surface: "plan", scope: route.scope, view: route.planView, query: view.query, zoom: view.zoom, rootIds: [...view.rootIds], showFinance: view.showFinance, toolsOpen: view.toolsOpen, includeArchivedMeetings: view.includeArchivedMeetings };
  } else if (route.surface === "meetings") {
    if (search.get("meeting_node") || search.get("meeting_nodes")) return null;
    const view = state.meetings[cockpitMeetingSavedViewKey(wsId, route.scope)] ?? EMPTY_COCKPIT_MEETING_CONTEXT;
    candidate = { surface: "meetings", scope: route.scope, view: view.view, archive: view.archive, query: view.query, anchorDay: view.anchorDay,
      from: search.get("from") || view.from, to: search.get("to") || view.to, tracks: [...view.tracks], kinds: [...view.kinds], statuses: [...view.statuses], parties: [...view.parties], only: [...view.only] };
  } else if (route.surface === "governance" && route.governanceView === "changes") {
    const view = state.governance[key] ?? EMPTY_COCKPIT_GOVERNANCE_CONTEXT;
    candidate = { surface: "governance", scope: route.scope, query: view.query, status: view.status, qualityOpen: view.qualityOpen };
  } else return null;
  const parsed = CockpitSavedViewDefinitionSchema.safeParse(candidate); return parsed.success ? parsed.data : null;
}

export function cockpitSavedViewPath(pathname: string, view: CockpitSavedViewDefinition) {
  const href = cockpitSurfacePath(pathname, view.surface, view.scope, view.surface === "plan" ? view.view : view.surface === "governance" ? "changes" : undefined);
  if (view.surface !== "meetings") return href;
  const query = new URLSearchParams(href.split("?")[1] ?? "");
  if (view.from) query.set("from", view.from); if (view.to) query.set("to", view.to);
  if (view.archive !== "active") query.set("meeting_archive", view.archive);
  return `${pathname}?${query}`;
}

/** Opening a saved view starts on its first page; existing server caches and entity facts are untouched. */
export function applyCockpitSavedView(wsId: string, input: CockpitSavedViewDefinition) {
  const view = CockpitSavedViewDefinitionSchema.parse(input); const key = cockpitScopeViewKey(wsId, view.scope);
  if (view.surface === "work") useCockpitDashboardViewStore.setState((state) => ({ views: { ...state.views, [key]: { ...EMPTY_COCKPIT_DASHBOARD_VIEW, audience: view.audience, kind: view.kind, mode: view.mode, pages: {} } } }));
  else if (view.surface === "plan") useCockpitScopeViewStore.getState().updatePlan(key, { ...EMPTY_COCKPIT_PLAN_CONTEXT, query: view.query, zoom: view.zoom, rootIds: [...view.rootIds], showFinance: view.showFinance, toolsOpen: view.toolsOpen, includeArchivedMeetings: view.includeArchivedMeetings, collapsedIds: [] });
  else if (view.surface === "meetings") useCockpitScopeViewStore.getState().updateMeeting(cockpitMeetingSavedViewKey(wsId, view.scope), { ...EMPTY_COCKPIT_MEETING_CONTEXT,
    view: view.view, archive: view.archive, query: view.query, anchorDay: view.anchorDay, from: view.from, to: view.to, tracks: [...view.tracks], kinds: [...view.kinds], statuses: [...view.statuses], parties: [...view.parties], only: [...view.only], cursors: [""] });
  else useCockpitScopeViewStore.getState().updateGovernance(key, { ...EMPTY_COCKPIT_GOVERNANCE_CONTEXT, query: view.query, status: view.status, qualityOpen: view.qualityOpen, cursors: [""] });
}
