export type CockpitArea = "work" | "operations" | "gantt" | "meetings" | "changes" | "finance";
export type CockpitBoardTab = "overview" | "gantt" | "meetings" | "changes" | "finance";
export type CockpitNodeView = "tasks" | "artifacts" | "acceptance" | "details";
export type CockpitMeetingView = "workflow" | "agenda" | "resources" | "details";
export type CockpitSurface = "work" | "plan" | "meetings" | "artifacts" | "governance";
export type CockpitPlanView = "gantt" | "table" | "responsibility" | "milestones" | "finance" | "operations";
export type CockpitGovernanceView = "changes" | "decisions" | "risks" | "history" | "automation";
export type CockpitArtifactView = "review" | "all" | "directory";

/** URL-owned project scope. A module without a project remains invalid rather than silently becoming all projects. */
export interface CockpitScope { projectId: string | null; moduleId: string | null }
export const EMPTY_COCKPIT_SCOPE: CockpitScope = { projectId: null, moduleId: null };

export function cockpitScope(search: { get: (name: string) => string | null }): CockpitScope {
  return { projectId: search.get("project") || null, moduleId: search.get("module") || null };
}

export function cockpitScopedPath(pathname: string, search: URLSearchParams, scope: CockpitScope): string {
  const query = new URLSearchParams(search);
  if (scope.projectId) query.set("project", scope.projectId); else query.delete("project");
  if (scope.moduleId) query.set("module", scope.moduleId); else query.delete("module");
  const suffix = query.toString();
  return suffix ? `${pathname}?${suffix}` : pathname;
}

export function cockpitSurfacePath(pathname: string, surface: CockpitSurface, scope: CockpitScope = EMPTY_COCKPIT_SCOPE,
  view?: CockpitPlanView | CockpitGovernanceView | CockpitArtifactView): string {
  const query = new URLSearchParams();
  if (surface !== "work") query.set("tab", surface);
  if (view && surface === "plan") query.set("plan_view", view);
  if (view && surface === "governance") query.set("governance_view", view);
  if (view && surface === "artifacts") query.set("artifact_view", view);
  return cockpitScopedPath(pathname, query, scope);
}

export function cockpitShellDestination(search: { get: (name: string) => string | null }): {
  surface: CockpitSurface; planView: CockpitPlanView; governanceView: CockpitGovernanceView; artifactView: CockpitArtifactView; scope: CockpitScope;
} {
  const tab = search.get("tab");
  const plan = search.get("plan_view"), governance = search.get("governance_view"), artifact = search.get("artifact_view");
  const surface: CockpitSurface = search.get("artifact") ? "artifacts" : search.get("meeting") ? "meetings" : search.get("node") ? "plan"
    : search.get("view") === "operations" || tab === "gantt" || tab === "finance" || tab === "plan" ? "plan"
      : tab === "changes" || tab === "governance" ? "governance"
        : tab === "meetings" || tab === "artifacts" ? tab : "work";
  const planView: CockpitPlanView = search.get("view") === "operations" ? "operations" : tab === "finance" ? "finance"
    : plan === "table" || plan === "responsibility" || plan === "milestones" || plan === "finance" || plan === "operations" ? plan : "gantt";
  return { surface, planView,
    governanceView: governance === "decisions" || governance === "risks" || governance === "history" || governance === "automation" ? governance : "changes",
    artifactView: artifact === "all" || artifact === "directory" ? artifact : "review", scope: cockpitScope(search) };
}

export interface CockpitDestination {
  area: CockpitArea;
  boardTab: CockpitBoardTab;
  nodeId: string | null;
  meetingId: string | null;
  actionId: string | null;
  agendaId: string | null;
  preparationId: string | null;
  nodeView: CockpitNodeView | null;
  meetingView: CockpitMeetingView | null;
  key: string;
}

/** A meeting target takes precedence over a conflicting node target. */
export function cockpitDestination(search: { get: (name: string) => string | null }): CockpitDestination {
  const meetingId = search.get("meeting") || null;
  const nodeId = meetingId ? null : search.get("node") || null;
  const actionId = meetingId ? search.get("action") || null : null;
  const agendaId = meetingId ? search.get("agenda") || null : null;
  const preparationId = meetingId ? search.get("preparation") || null : null;
  const requestedNodeView = search.get("node_view");
  const requestedMeetingView = search.get("meeting_view");
  const nodeView = nodeId && (requestedNodeView === "tasks" || requestedNodeView === "artifacts" || requestedNodeView === "acceptance" || requestedNodeView === "details") ? requestedNodeView : null;
  const meetingView = meetingId && (requestedMeetingView === "workflow" || requestedMeetingView === "agenda" || requestedMeetingView === "resources" || requestedMeetingView === "details") ? requestedMeetingView : null;
  const tab = search.get("tab");
  const area: CockpitArea = meetingId ? "meetings" : nodeId ? "gantt"
    : search.get("view") === "operations" ? "operations"
      : tab === "gantt" || tab === "meetings" || tab === "changes" || tab === "finance" ? tab : "work";
  return { area, boardTab: area === "operations" || area === "work" ? "overview" : area,
    nodeId, meetingId, actionId, agendaId, preparationId, nodeView, meetingView, key: JSON.stringify([area, nodeId, meetingId]) };
}

/** Section changes deliberately drop stale object targets and unrelated filters. */
export function cockpitAreaPath(pathname: string, area: CockpitArea): string {
  if (area === "work") return pathname;
  return `${pathname}?${area === "operations" ? "view=operations" : `tab=${area}`}`;
}

export function cockpitObjectPath(pathname: string, target: { kind: "node"; id: string; view?: CockpitNodeView; planView?: CockpitPlanView; requestId?: string } | { kind: "meeting"; id: string; actionId?: string; agendaId?: string; preparationId?: string; view?: CockpitMeetingView }, scope: CockpitScope = EMPTY_COCKPIT_SCOPE): string {
  const query = new URLSearchParams({ [target.kind]: target.id });
  if (target.kind === "meeting" && target.actionId) query.set("action", target.actionId);
  if (target.kind === "meeting" && target.agendaId) {
    query.set("agenda", target.agendaId);
    if (!target.view) query.set("meeting_view", "agenda");
  }
  if (target.kind === "meeting" && target.preparationId) {
    query.set("preparation", target.preparationId);
    if (!target.view) query.set("meeting_view", "agenda");
  }
  if (target.view) query.set(`${target.kind}_view`, target.view);
  if (target.kind === "node" && target.requestId) query.set("acceptance", target.requestId);
  if (target.kind === "node" && target.planView) query.set("plan_view", target.planView);
  return cockpitScopedPath(pathname, query, scope);
}

export interface CockpitArtifactReturn { nodeId: string; view: "artifacts" | "acceptance"; requestId?: string; scope?: CockpitScope }
export function cockpitArtifactReturn(search: { get: (name: string) => string | null }): CockpitArtifactReturn | undefined {
  const nodeId = search.get("from_node");
  if (!nodeId) return undefined;
  return { nodeId, view: search.get("from_view") === "acceptance" ? "acceptance" : "artifacts", scope: { projectId: search.get("from_project") || null, moduleId: search.get("from_module") || null }, ...(search.get("from_request") ? { requestId: search.get("from_request")! } : {}) };
}
export function cockpitArtifactPath(pathname: string, artifactId: string, scope: CockpitScope, versionId?: string, back?: CockpitArtifactReturn): string {
  const query = new URLSearchParams({ tab: "artifacts", artifact: artifactId });
  if (versionId) query.set("artifact_version", versionId);
  if (back) {
    query.set("from_node", back.nodeId); query.set("from_view", back.view); if (back.requestId) query.set("from_request", back.requestId);
    const originScope = back.scope ?? scope;
    if (originScope.projectId) query.set("from_project", originScope.projectId);
    if (originScope.moduleId) query.set("from_module", originScope.moduleId);
  }
  return cockpitScopedPath(pathname, query, scope);
}

/** Keep the originating meeting register window while opening or closing its workbench. */
export function cockpitMeetingContextPath(pathname: string, meetingId: string | null, scope: CockpitScope,
  source: { get: (key: string) => string | null }, view?: CockpitMeetingView): string {
  const base = meetingId ? cockpitObjectPath(pathname, { kind: "meeting", id: meetingId, view }, scope) : cockpitSurfacePath(pathname, "meetings", scope);
  const query = new URLSearchParams(base.split("?")[1] ?? "");
  if (meetingId && source.get("meeting") === meetingId && source.get("action")) query.set("action", source.get("action")!);
  if (meetingId && source.get("meeting") === meetingId && source.get("agenda")) query.set("agenda", source.get("agenda")!);
  if (meetingId && source.get("meeting") === meetingId && source.get("preparation")) query.set("preparation", source.get("preparation")!);
  for (const name of ["meeting_node", "meeting_nodes", "meeting_archive", "from", "to"] as const) {
    const value = source.get(name); if (value) query.set(name, value);
  }
  return `${pathname}?${query}`;
}

/** Opening or closing one topic preserves the meeting workbench's other URL state. */
export function cockpitMeetingAgendaPath(pathname: string, meetingId: string, agendaId: string | null,
  source: { toString(): string }): string {
  const query = new URLSearchParams(source.toString());
  if (query.get("meeting") !== meetingId) query.delete("action");
  for (const name of ["node", "node_view", "artifact", "artifact_version", "acceptance", "preparation"]) query.delete(name);
  query.set("meeting", meetingId);
  query.set("meeting_view", "agenda");
  if (agendaId) query.set("agenda", agendaId); else query.delete("agenda");
  return `${pathname}?${query}`;
}

/** An operation is a meeting subview; closing it restores the selected topic. */
export function cockpitMeetingPreparationPath(pathname: string, meetingId: string, preparationId: string | null,
  source: { toString(): string }): string {
  const query = new URLSearchParams(source.toString());
  if (query.get("meeting") !== meetingId) { query.delete("action"); query.delete("agenda"); }
  for (const name of ["node", "node_view", "artifact", "artifact_version", "acceptance"]) query.delete(name);
  query.set("meeting", meetingId);
  query.set("meeting_view", "agenda");
  if (preparationId) query.set("preparation", preparationId); else query.delete("preparation");
  return `${pathname}?${query}`;
}
