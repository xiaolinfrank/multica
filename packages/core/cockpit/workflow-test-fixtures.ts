import { CockpitMeetingWorkflowSchema, CockpitMinutesVersionSchema } from "../api/schemas";
import type { CockpitMeetingWorkflow, CockpitMinutesVersion } from "../types";

export const WORKFLOW_MEETING_ID = "10000000-0000-4000-8000-000000000001";
export const WORKFLOW_SUBMISSION_KEY = "20000000-0000-4000-8000-000000000001";

export function workflowFixture(overrides: Partial<CockpitMeetingWorkflow> = {}): CockpitMeetingWorkflow {
  return { ...CockpitMeetingWorkflowSchema.parse({
    enabled: true, meeting_id: WORKFLOW_MEETING_ID, revision: 1, reviewer_id: "reviewer-1",
    minutes_issue: { id: "minutes-1", identifier: "BIO-1", title: "Write minutes", status: "backlog", assignee_type: "member", assignee_id: "writer-1" },
    can_manage: true, can_submit: true, can_review: true, can_publish: true,
  }), ...(overrides.released_at ? { ended_at: "2026-10-09T10:00:00Z", materials_ready: true } : {}), ...overrides };
}

export function versionFixture(overrides: Partial<CockpitMinutesVersion> = {}): CockpitMinutesVersion {
  return { ...CockpitMinutesVersionSchema.parse({
    id: "version-1", version_number: 1, submission_key: WORKFLOW_SUBMISSION_KEY,
    content: "Fixed minutes text", content_hash: "hash-of-fixed-text", source_issue_id: "minutes-1",
    review_issue: { id: "review-1", identifier: "BIO-2", title: "Review v1", status: "todo", assignee_type: "member", assignee_id: "reviewer-1" },
    reviewer_id: "reviewer-1", decision: "pending", submitted_by_type: "member", submitted_by_id: "writer-1", created_at: "2026-10-09T10:00:00Z",
  }), ...overrides };
}
