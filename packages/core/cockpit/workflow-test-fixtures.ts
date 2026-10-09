import { CockpitMeetingWorkflowSchema, CockpitMinutesVersionSchema } from "../api/schemas";
import type { CockpitMeetingWorkflow, CockpitMinutesVersion, CockpitReviewerHandoff, CockpitNasExport } from "../types";

export const WORKFLOW_MEETING_ID = "10000000-0000-4000-8000-000000000001";
export const WORKFLOW_SUBMISSION_KEY = "20000000-0000-4000-8000-000000000001";
export const WORKFLOW_HANDOFF_KEY = "30000000-0000-4000-8000-000000000001";

export function nasExportFixture(overrides: Partial<CockpitNasExport> = {}): CockpitNasExport {
  return {
    id: "nas-operation-1", version_id: "version-1", version_number: 1, source_issue_id: "minutes-1", content_hash: "hash-of-fixed-text",
    root_id: "nas-root-1", directory: "/Volumes/team/Meeting", target_path: "/Volumes/team/Meeting/已发布纪要/fixed-version.md",
    size_bytes: null, status: "queued", attempts: 0, revision: 1, next_retry_at: null,
    created_at: "2026-10-09T12:00:00Z", updated_at: "2026-10-09T12:00:00Z", completed_at: null,
    last_error_code: "", last_error: "", can_retry: false, ...overrides,
  };
}

export function handoffFixture(overrides: Partial<CockpitReviewerHandoff> = {}): CockpitReviewerHandoff {
  return { id: "handoff-1", handoff_key: WORKFLOW_HANDOFF_KEY, from_reviewer_id: "reviewer-1", to_reviewer_id: "reviewer-2",
    version_id: "version-1", from_review_issue: { ...versionFixture().review_issue, status: "cancelled" },
    to_review_issue: { ...versionFixture().review_issue, id: "review-2", identifier: "BIO-3", assignee_id: "reviewer-2" },
    reason: "Reviewer left the team", created_by: "manager-1", created_at: "2026-10-10T10:00:00Z", revision: 2, ...overrides };
}

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
