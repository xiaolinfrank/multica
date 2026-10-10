import type { CockpitMeetingWorkflowSummary, CockpitMinutesVersionMetadata, CockpitWorkflowCommand, CockpitWorkflowCommandResponse, CockpitWorkflowNasExport } from "../types";
import { isAbsoluteCollabPath } from "../projects/collab-path";
import { sameCockpitNasDestination } from "./nas-export";

export function cockpitWorkflowVersionMatches(summary: CockpitMeetingWorkflowSummary, version: CockpitMinutesVersionMetadata | null): boolean {
  return Boolean(version?.id && version.version_number > 0 && version.content_hash && version.source_issue_id === summary.minutes_issue?.id && version.review_issue.id && version.reviewer_id);
}

export function validCockpitWorkflowSummary(summary: CockpitMeetingWorkflowSummary): boolean {
  if (!summary.enabled) return summary.revision === 0 && !summary.current_version_id && !summary.published_version_id && !summary.current_version && !summary.published_version;
  return Boolean(summary.revision > 0 && summary.minutes_issue?.id && summary.reviewer_id
    && (!summary.released_at || (summary.ended_at && summary.materials_ready))
    && (summary.current_version_id ? summary.current_version?.id === summary.current_version_id && cockpitWorkflowVersionMatches(summary, summary.current_version) : !summary.current_version)
    && (summary.published_version_id ? summary.published_version?.id === summary.published_version_id && cockpitWorkflowVersionMatches(summary, summary.published_version)
      && summary.published_version.decision === "approved" && summary.published_version.published_at : !summary.published_version));
}

export function cockpitWorkflowSummaryActions(workflow: CockpitMeetingWorkflowSummary, userId: string) {
  const current = workflow.current_version;
  const valid = workflow.enabled && validCockpitWorkflowSummary(workflow);
  const validVersion = cockpitWorkflowVersionMatches(workflow, current);
  const canManage = Boolean(valid && userId && workflow.can_manage);
  const hasExecutor = Boolean(workflow.minutes_issue?.assignee_id && ["member", "agent", "squad"].includes(workflow.minutes_issue.assignee_type));
  const isWriter = workflow.minutes_issue?.assignee_type === "member" && workflow.minutes_issue.assignee_id === userId;
  return { current, valid, canManage, hasExecutor,
    canReassignReviewer: Boolean(canManage && workflow.can_reassign_reviewer && (!current || (validVersion && ["pending", "approved", "changes_requested", "rejected"].includes(current.decision)))),
    canRelease: Boolean(canManage && hasExecutor && workflow.ended_at && workflow.materials_ready && !workflow.released_at && workflow.minutes_issue?.status === "backlog"),
    canSubmit: Boolean(valid && userId && workflow.can_submit && (canManage || isWriter) && workflow.released_at
      && (!current || (validVersion && ["approved", "changes_requested", "rejected"].includes(current.decision)))),
    canReview: Boolean(valid && validVersion && userId && workflow.can_review && current?.reviewer_id === userId && current.decision === "pending"),
    canPublish: Boolean(valid && validVersion && userId && workflow.can_publish && current?.decision === "approved" && workflow.published_version_id !== current.id),
  };
}

export function cockpitWorkflowSummaryPollInterval(workflow: CockpitMeetingWorkflowSummary | null | undefined, deadline: number, now = Date.now()): number | false {
  return workflow?.enabled && workflow.history_counts.nas_active > 0 && now < deadline ? 10_000 : false;
}

export function cockpitWorkflowNasExportValid(summary: CockpitMeetingWorkflowSummary, job: CockpitWorkflowNasExport): boolean {
  const version = job.source_version;
  return Boolean(summary.enabled && cockpitWorkflowVersionMatches(summary, version) && version.decision === "approved" && version.published_at
    && job.id && job.revision > 0 && job.version_id === version.id && job.version_number === version.version_number && job.content_hash === version.content_hash
    && job.source_issue_id === version.source_issue_id && job.root_id && isAbsoluteCollabPath(job.directory) && isAbsoluteCollabPath(job.target_path)
    && (job.status !== "succeeded" || (job.completed_at && job.size_bytes !== null)));
}

/** Receipts acknowledge one command even when later work has moved the current version or reviewer. */
export function acknowledgedCockpitWorkflowCommand(result: CockpitWorkflowCommandResponse, command: CockpitWorkflowCommand): boolean {
  const workflow = result.workflow;
  const { version, handoff, nas_export: job } = result.receipt;
  if (!workflow.enabled || !validCockpitWorkflowSummary(workflow) || result.receipt.action !== command.action) return false;
  const validVersion = Boolean(version?.id && version.content.trim() && version.content_hash && version.source_issue_id === workflow.minutes_issue?.id && version.review_issue.id);
  switch (command.action) {
    case "enabled": return workflow.reviewer_id === command.body.reviewer_id && (!command.body.existing_issue_id
      || workflow.minutes_issue?.id === command.body.existing_issue_id || workflow.minutes_issue?.identifier === command.body.existing_issue_id);
    case "readiness": return workflow.revision >= command.body.expected_revision && (command.body.ended !== true || Boolean(workflow.ended_at))
      && (command.body.materials_ready === undefined || workflow.materials_ready === command.body.materials_ready);
    case "released": return workflow.revision >= command.body.expected_revision && Boolean(workflow.ended_at && workflow.materials_ready && workflow.released_at);
    case "submitted": return Boolean(validVersion && version?.submission_key === command.body.submission_key && version.content === command.body.content.trim());
    case "reviewed": return Boolean(workflow.revision >= command.body.expected_revision && validVersion && version?.id === command.version_id
      && version.decision === command.body.decision && version.feedback === command.body.feedback.trim() && version.reviewed_at);
    case "published": return Boolean(workflow.revision >= command.body.expected_revision && validVersion && version?.id === command.version_id
      && version.decision === "approved" && version.published_at && (!command.body.nas_export || (job && cockpitWorkflowNasExportValid(workflow, job)
        && job.version_id === command.version_id && sameCockpitNasDestination(job, command.body.nas_export))));
    case "reviewer_reassigned": return Boolean(handoff && handoff.handoff_key === command.body.handoff_key && handoff.to_reviewer_id === command.body.reviewer_id
      && handoff.reason === command.body.reason.trim() && handoff.revision === command.body.expected_revision + 1 && handoff.revision <= workflow.revision
      && handoff.from_reviewer_id !== handoff.to_reviewer_id && (handoff.version_id === null
        ? handoff.from_review_issue === null && handoff.to_review_issue === null && handoff.version_number === null
        : validVersion && version?.id === handoff.version_id && version.version_number === handoff.version_number
          && handoff.from_review_issue?.id && handoff.to_review_issue?.id && handoff.from_review_issue.id !== handoff.to_review_issue.id));
    case "nas_export_queued": return Boolean(job && cockpitWorkflowNasExportValid(workflow, job) && job.version_id === command.version_id && sameCockpitNasDestination(job, command.body));
    case "nas_export_retried": return Boolean(job && cockpitWorkflowNasExportValid(workflow, job) && job.id === command.operation.id
      && job.version_id === command.operation.version_id && job.content_hash === command.operation.content_hash && job.source_issue_id === command.operation.source_issue_id
      && sameCockpitNasDestination(job, command.operation) && job.target_path === command.operation.target_path && job.revision >= command.operation.revision
      && ["queued", "running", "succeeded"].includes(job.status));
  }
}

/** A compact response replaces a snapshot; it never accumulates history in the working-state cache. */
export function mergeCockpitWorkflowSummary(current: CockpitMeetingWorkflowSummary | undefined, incoming: CockpitMeetingWorkflowSummary): CockpitMeetingWorkflowSummary {
  if (!current || current.meeting_id !== incoming.meeting_id || current.workspace_id !== incoming.workspace_id) return incoming;
  const latest = current.revision > incoming.revision ? current : incoming;
  const other = latest === incoming ? current : incoming;
  const pin = latest.published_nas_export;
  const otherPin = other.published_nas_export;
  const sameTarget = latest.published_version_id === other.published_version_id && sameCockpitNasDestination(latest.nas_destination, other.nas_destination);
  if (sameTarget && otherPin && (!pin || (otherPin.id === pin.id && otherPin.revision > pin.revision))) {
    return { ...latest, published_nas_export: { ...otherPin, can_retry: Boolean(pin?.can_retry && otherPin.can_retry) },
      history_counts: { ...latest.history_counts, nas_exports: Math.max(latest.history_counts.nas_exports, other.history_counts.nas_exports),
        nas_active: Math.max(latest.history_counts.nas_active, other.history_counts.nas_active) } };
  }
  return latest;
}
