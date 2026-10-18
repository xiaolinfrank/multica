import { CockpitMeetingWorkflowSchema, CockpitMinutesVersionSchema } from "@multica/core/api/schemas";
import type { CockpitMeetingWorkflow, CockpitMinutesVersion, CockpitMeetingWorkflowSummary, CockpitWorkflowCommand, CockpitWorkflowCommandResponse, CockpitWorkflowNasExport } from "@multica/core/types";

export const WORKFLOW_MEETING_ID = "10000000-0000-4000-8000-000000000001";
export const WORKFLOW_SUBMISSION_KEY = "20000000-0000-4000-8000-000000000001";

export function workflowFixture(overrides: Partial<CockpitMeetingWorkflow> = {}): CockpitMeetingWorkflow {
  return { ...CockpitMeetingWorkflowSchema.parse({
    enabled: true, meeting_id: WORKFLOW_MEETING_ID, revision: 1, reviewer_id: "reviewer-1",
    minutes_issue: { id: "minutes-1", identifier: "BIO-1", title: "Write minutes", status: "backlog", assignee_type: "member", assignee_id: "writer-1" },
    minutes_issues: [{ issue: { id: "minutes-1", identifier: "BIO-1", title: "Write minutes", status: "backlog", assignee_type: "member", assignee_id: "writer-1" }, is_focus: true, roles: ["minutes"] }],
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

export function versionMetadata(version: CockpitMinutesVersion) {
  const { content: _content, feedback, ...metadata } = version;
  return { ...metadata, has_feedback: Boolean(feedback) };
}

export function historyNasJobs(legacy: CockpitMeetingWorkflow): CockpitWorkflowNasExport[] {
  return legacy.nas_exports.map((job) => {
    const version = legacy.versions.find((version) => version.id === job.version_id);
    if (!version) throw new Error("NAS fixture source version missing");
    return { ...job, source_version: versionMetadata(version) };
  });
}

/** Fixture-only projection: the real service creates this shape without loading history bodies. */
export function workflowSummary(legacy: CockpitMeetingWorkflow): CockpitMeetingWorkflowSummary {
  const { versions, reviewer_handoffs, nas_exports, ...header } = legacy;
  const current = versions.find((version) => version.id === header.current_version_id);
  const published = versions.find((version) => version.id === header.published_version_id);
  return { ...header, representation: "summary", workspace_id: "ws-1", current_version: current ? versionMetadata(current) : null,
    published_version: published ? versionMetadata(published) : null,
    published_nas_export: historyNasJobs(legacy).find((job) => job.version_id === published?.id && header.nas_destination && job.root_id === header.nas_destination.root_id && job.directory === header.nas_destination.directory) ?? null,
    history_counts: { versions: versions.length, reviewer_handoffs: reviewer_handoffs.length, nas_exports: nas_exports.length,
      nas_active: nas_exports.filter((job) => ["queued", "running", "retry_wait"].includes(job.status)).length } };
}

export function compactWorkflow(legacy: CockpitMeetingWorkflow, command: CockpitWorkflowCommand): CockpitWorkflowCommandResponse {
  const workflow = workflowSummary(legacy);
  const handoff = command.action === "reviewer_reassigned" ? legacy.reviewer_handoffs.find((entry) => entry.handoff_key === command.body.handoff_key) ?? null : null;
  const versionId = "version_id" in command ? command.version_id : handoff?.version_id;
  const version = command.action === "submitted" ? legacy.versions.find((entry) => entry.submission_key === command.body.submission_key) ?? null
    : legacy.versions.find((entry) => entry.id === versionId) ?? null;
  return { representation: "compact", workspace_id: "ws-1", meeting_id: legacy.meeting_id, workflow,
    receipt: { action: command.action, version, handoff: handoff ? { ...handoff, version_number: legacy.versions.find((entry) => entry.id === handoff.version_id)?.version_number ?? null } : null,
      nas_export: command.action === "nas_export_retried" ? historyNasJobs(legacy).find((job) => job.id === command.operation.id) ?? null
        : historyNasJobs(legacy).find((job) => job.version_id === versionId) ?? null } };
}
