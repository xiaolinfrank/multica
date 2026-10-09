import type { CockpitAttentionTarget } from "../types/cockpit-overview";

export type CockpitAttentionDestination = { kind: "issue"; id: string } | { kind: "node"; id: string } | { kind: "meeting"; id: string; actionId?: string };

/** Unknown destinations remain visible but never fall back to an unrelated homepage. */
export function cockpitAttentionDestination(target: CockpitAttentionTarget): CockpitAttentionDestination | null {
  if (target.kind === "issue") {
    const id = target.issue_id || target.id;
    return id && (!target.issue_id || !target.id || target.issue_id === target.id) ? { kind: "issue", id } : null;
  }
  if (target.kind === "node") {
    const id = target.node_id || target.id;
    return id && (!target.node_id || !target.id || target.node_id === target.id) ? { kind: "node", id } : null;
  }
  if (target.kind === "meeting") {
    const id = target.meeting_id || target.id;
    return id && (!target.meeting_id || !target.id || target.meeting_id === target.id) ? { kind: "meeting", id } : null;
  }
  if (target.kind === "action") {
    const actionId = target.action_id || target.id;
    return target.meeting_id && actionId && (!target.action_id || !target.id || target.action_id === target.id)
      ? { kind: "meeting", id: target.meeting_id, actionId } : null;
  }
  return null;
}
