import type { CockpitBoard, CockpitContextData, CockpitPlanData, CockpitNodeDetailData, CockpitMeetingDetailData, CockpitMeetingRegisterPage, CockpitMeetingRegisterQuery, CockpitMeetingCard } from "@multica/core/types";
import type { CockpitScope } from "@multica/core/cockpit";
const EMPTY_COCKPIT_SCOPE: CockpitScope = { projectId: null, moduleId: null };

export function cockpitContextFixture(board: CockpitBoard, scope: CockpitScope = EMPTY_COCKPIT_SCOPE): CockpitContextData {
  return { workspace_id: "ws-1", cockpit: board.cockpit, scope: { project_id: scope.projectId, module_id: scope.moduleId, project_title: "", module_title: "" },
    actor: { user_id: "user-1", role: "member", is_human: true }, has_meeting_workflows: board.has_meeting_workflows === true,
    has_stable_bindings: board.nodes.some((node) => Boolean(node.project_id || node.module_id)) };
}
export function cockpitPlanFixture(board: CockpitBoard, scope: CockpitScope = EMPTY_COCKPIT_SCOPE): CockpitPlanData {
  return { ...cockpitContextFixture(board, scope), complete: true, nodes: board.nodes, payments: board.payments, milestones: board.milestones, context_node_ids: [], node_index: board.nodes,
    task_counts: board.nodes.map((node) => ({ node_id: node.id, primary_total: 0, reference_total: board.issue_links.filter((link) => link.node_id === node.id).length, active: 0, done: 0, closed: 0 })),
    counts: { nodes: board.nodes.length, payments: board.payments.length, milestones: board.milestones.length, index_nodes: board.nodes.length } };
}
export function cockpitMeetingCardFixture(board: CockpitBoard, id: string): CockpitMeetingCard {
  const found = board.meetings.find((meeting) => meeting.id === id); if (!found) throw new Error(`Missing fixture meeting ${id}`);
  const { note, minutes, decisions, actions, ...metadata } = found;
  return { ...metadata, issue_count: board.meeting_issues.filter((link) => link.meeting_id === id).length, node_count: board.meeting_nodes.filter((link) => link.meeting_id === id).length,
    workflow_enabled: false, workflow_stage: "not_enabled", display_excerpt: Array.from(decisions.trim() || actions.trim() || minutes.trim() || note.trim()).slice(0, 200).join("") };
}
export function cockpitMeetingRegisterFixture(board: CockpitBoard, scope: CockpitScope, query: CockpitMeetingRegisterQuery): CockpitMeetingRegisterPage {
  const matches = board.meetings.filter((meeting) => (!query.date_from || Boolean(meeting.meet_date && meeting.meet_date >= query.date_from))
    && (!query.date_to || Boolean(meeting.meet_date && meeting.meet_date <= query.date_to)));
  const counts = new Map<string, number>(); for (const meeting of matches) if (meeting.meet_date) counts.set(meeting.meet_date, (counts.get(meeting.meet_date) ?? 0) + 1);
  const offset = Number(query.cursor || 0), size = query.page_size ?? 25;
  return { workspace_id: "ws-1", scope: cockpitContextFixture(board, scope).scope, node_id: query.node_id ?? null, node_ids: query.node_ids ?? [], items: matches.slice(offset, offset + size).map((meeting) => cockpitMeetingCardFixture(board, meeting.id)),
    total: matches.length, next_cursor: offset + size < matches.length ? String(offset + size) : null, date_from: query.date_from ?? null, date_to: query.date_to ?? null,
    day_counts: query.date_from && query.date_to ? [...counts].map(([date, total]) => ({ date, total })) : [] };
}
export function cockpitNodeDetailFixture(board: CockpitBoard, id: string, scope: CockpitScope = EMPTY_COCKPIT_SCOPE): CockpitNodeDetailData {
  const node = board.nodes.find((item) => item.id === id); if (!node) throw new Error(`Missing fixture node ${id}`);
  const ancestors = []; let parent = board.nodes.find((item) => item.id === node.parent_id);
  while (parent) { ancestors.unshift(parent); parent = board.nodes.find((item) => item.id === parent?.parent_id); }
  const source = [node, ...[...ancestors].reverse()].find((item) => item.project_id || item.module_id);
  const children = board.nodes.filter((item) => item.parent_id === id).length;
  const payments = board.payments.filter((payment) => payment.node_id === id);
  const meetings = board.meeting_nodes.filter((link) => link.node_id === id).map((link) => cockpitMeetingCardFixture(board, link.meeting_id));
  return { ...cockpitContextFixture(board, scope), node, ancestors, children_count: children, scope_match: true, node_index: board.nodes,
    binding: { project_id: source?.project_id ?? null, module_id: source?.module_id ?? null, project_title: "", module_title: "", source_node_id: source?.id ?? null,
      eligible: !node.project_id && !node.module_id && children === 0 && Boolean(source?.module_id), reason: !source ? "project_binding_required" : !source.module_id ? "module_binding_required" : "" },
    payments: { items: payments.slice(0, 25), total: payments.length, next_cursor: payments.length > 25 ? "25" : null }, payment_total: payments.reduce((sum, payment) => sum + payment.amount, 0),
    meetings: { items: meetings.slice(0, 25), total: meetings.length, next_cursor: meetings.length > 25 ? "25" : null } };
}
export function cockpitMeetingDetailFixture(board: CockpitBoard, id: string, scope: CockpitScope = EMPTY_COCKPIT_SCOPE): CockpitMeetingDetailData {
  const meeting = board.meetings.find((item) => item.id === id); if (!meeting) throw new Error(`Missing fixture meeting ${id}`);
  const issues = board.meeting_issues.filter((link) => link.meeting_id === id);
  const nodes = board.meeting_nodes.filter((link) => link.meeting_id === id).map((link) => { const node = board.nodes.find((item) => item.id === link.node_id); return { ...link, code: node?.code ?? "", name: node?.name ?? "" }; });
  return { ...cockpitContextFixture(board, scope), meeting, scope_match: true, node_index: board.nodes,
    linked_issues: { items: issues.slice(0, 25), total: issues.length, next_cursor: issues.length > 25 ? "25" : null }, linked_nodes: { items: nodes.slice(0, 25), total: nodes.length, next_cursor: nodes.length > 25 ? "25" : null } };
}
