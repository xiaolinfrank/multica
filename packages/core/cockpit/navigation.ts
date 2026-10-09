export type CockpitArea = "work" | "operations" | "gantt" | "meetings" | "changes" | "finance";
export type CockpitBoardTab = "overview" | "gantt" | "meetings" | "changes" | "finance";

export interface CockpitDestination {
  area: CockpitArea;
  boardTab: CockpitBoardTab;
  nodeId: string | null;
  meetingId: string | null;
  actionId: string | null;
  key: string;
}

/** A meeting target takes precedence over a conflicting node target. */
export function cockpitDestination(search: { get: (name: string) => string | null }): CockpitDestination {
  const meetingId = search.get("meeting") || null;
  const nodeId = meetingId ? null : search.get("node") || null;
  const actionId = meetingId ? search.get("action") || null : null;
  const tab = search.get("tab");
  const area: CockpitArea = meetingId ? "meetings" : nodeId ? "gantt"
    : search.get("view") === "operations" ? "operations"
      : tab === "gantt" || tab === "meetings" || tab === "changes" || tab === "finance" ? tab : "work";
  return { area, boardTab: area === "operations" || area === "work" ? "overview" : area,
    nodeId, meetingId, actionId, key: JSON.stringify([area, nodeId, meetingId]) };
}

/** Section changes deliberately drop stale object targets and unrelated filters. */
export function cockpitAreaPath(pathname: string, area: CockpitArea): string {
  if (area === "work") return pathname;
  return `${pathname}?${area === "operations" ? "view=operations" : `tab=${area}`}`;
}

export function cockpitObjectPath(pathname: string, target: { kind: "node"; id: string } | { kind: "meeting"; id: string; actionId?: string }): string {
  const query = new URLSearchParams({ [target.kind]: target.id });
  if (target.kind === "meeting" && target.actionId) query.set("action", target.actionId);
  return `${pathname}?${query.toString()}`;
}
