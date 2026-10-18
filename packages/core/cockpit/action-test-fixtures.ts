import { CockpitMeetingActionSchema, CockpitTaskSchema } from "../api/schemas";
import type { CockpitActionPage, CockpitMeetingAction, CockpitTask, CockpitTaskPage } from "../types";

export const PROPOSAL_KEY = "40000000-0000-4000-8000-000000000001";
export const DECISION_KEY = "40000000-0000-4000-8000-000000000002";
export const CREATION_KEY = "40000000-0000-4000-8000-000000000003";
export function actionTaskFixture(overrides: Partial<CockpitTask> = {}): CockpitTask {
  return { ...CockpitTaskSchema.parse({ id: "issue-1", identifier: "PMO-1", title: "Verify interface", status: "backlog", status_category: "unstarted",
    project_id: "project-1", module_id: "module-1", primary_node_id: "node-1", primary_revision: 1, assignee_type: "member", assignee_id: "member-1", assignee_name: "Owner" }), ...overrides };
}
export function actionFixture(overrides: Partial<CockpitMeetingAction> = {}): CockpitMeetingAction {
  return { ...CockpitMeetingActionSchema.parse({ id: "action-1", meeting_id: "meeting-1", version_id: "version-1", version_number: 1,
    source_content_hash: "fixed-hash", source_quote: "Verify interface.", title: "Verify interface", description: "Check all required fields.",
    status: "draft", revision: 1, proposal_key: PROPOSAL_KEY, created_by: "member-1", created_at: "2026-10-10T10:00:00Z", updated_at: "2026-10-10T10:00:00Z",
    can_edit: true, can_resolve: true }), ...overrides };
}
export function actionPageFixture(overrides: Partial<CockpitActionPage> = {}): CockpitActionPage {
  return { meeting_id: "meeting-1", items: [actionFixture()], total: 1, filtered_total: 1, next_cursor: null, can_add: true, ...overrides };
}
export function taskPageFixture(overrides: Partial<CockpitTaskPage> = {}): CockpitTaskPage {
  return { node_id: "node-1", items: [actionTaskFixture()], total: 1, filtered_total: 1, next_cursor: null,
    summary: { total: 1, by_status: [{ status: "backlog", category: "unstarted", count: 1 }], by_category: { unstarted: 1, started: 0, done: 0, closed: 0, unknown: 0 }, done: 0, closed: 0, unknown: 0 },
    eligibility: { eligible: true, reason: "", project_id: "project-1", module_id: "module-1" }, ...overrides };
}
