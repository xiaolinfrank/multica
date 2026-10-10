export type CockpitArea = "work" | "operations" | "gantt" | "meetings" | "changes" | "finance";
export type CockpitBoardTab = "overview" | "gantt" | "meetings" | "changes" | "finance";
export type CockpitNodeView = "tasks" | "details";
export type CockpitMeetingView = "workflow" | "resources" | "details";

export interface CockpitDestination {
  area: CockpitArea;
  boardTab: CockpitBoardTab;
  nodeId: string | null;
  meetingId: string | null;
  actionId: string | null;
  nodeView: CockpitNodeView | null;
  meetingView: CockpitMeetingView | null;
  key: string;
}

/** A meeting target takes precedence over a conflicting node target. */
export function cockpitDestination(search: { get: (name: string) => string | null }): CockpitDestination {
  const meetingId = search.get("meeting") || null;
  const nodeId = meetingId ? null : search.get("node") || null;
  const actionId = meetingId ? search.get("action") || null : null;
  const requestedNodeView = search.get("node_view");
  const requestedMeetingView = search.get("meeting_view");
  const nodeView = nodeId && (requestedNodeView === "tasks" || requestedNodeView === "details") ? requestedNodeView : null;
  const meetingView = meetingId && (requestedMeetingView === "workflow" || requestedMeetingView === "resources" || requestedMeetingView === "details") ? requestedMeetingView : null;
  const tab = search.get("tab");
  const area: CockpitArea = meetingId ? "meetings" : nodeId ? "gantt"
    : search.get("view") === "operations" ? "operations"
      : tab === "gantt" || tab === "meetings" || tab === "changes" || tab === "finance" ? tab : "work";
  return { area, boardTab: area === "operations" || area === "work" ? "overview" : area,
    nodeId, meetingId, actionId, nodeView, meetingView, key: JSON.stringify([area, nodeId, meetingId]) };
}

/** Section changes deliberately drop stale object targets and unrelated filters. */
export function cockpitAreaPath(pathname: string, area: CockpitArea): string {
  if (area === "work") return pathname;
  return `${pathname}?${area === "operations" ? "view=operations" : `tab=${area}`}`;
}

export function cockpitObjectPath(pathname: string, target: { kind: "node"; id: string; view?: CockpitNodeView } | { kind: "meeting"; id: string; actionId?: string; view?: CockpitMeetingView }): string {
  const query = new URLSearchParams({ [target.kind]: target.id });
  if (target.kind === "meeting" && target.actionId) query.set("action", target.actionId);
  if (target.view) query.set(`${target.kind}_view`, target.view);
  return `${pathname}?${query.toString()}`;
}
