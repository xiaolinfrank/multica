import type { CockpitMeetingWorkflow } from "../types";

/** Capability hints are combined with the actual workflow facts and the designated human reviewer. */
export function cockpitWorkflowActions(workflow: CockpitMeetingWorkflow, userId: string) {
  const current = workflow.versions.find((version) => version.id === workflow.current_version_id) ?? null;
  const valid = Boolean(workflow.enabled && workflow.minutes_issue?.id && workflow.reviewer_id && workflow.revision > 0
    && (!workflow.released_at || (workflow.ended_at && workflow.materials_ready))
    && (!workflow.current_version_id || current)
    && (!workflow.published_version_id || workflow.versions.some((version) => version.id === workflow.published_version_id)));
  const validVersion = Boolean(current?.id && current.content.trim() && current.content_hash && current.version_number > 0
    && current.source_issue_id === workflow.minutes_issue?.id);
  const canManage = Boolean(valid && userId && workflow.can_manage);
  const isWriter = workflow.minutes_issue?.assignee_type === "member" && workflow.minutes_issue.assignee_id === userId;
  return {
    current,
    valid,
    canManage,
    canRelease: canManage && Boolean(workflow.ended_at && workflow.materials_ready && !workflow.released_at
      && workflow.minutes_issue?.status === "backlog"),
    canSubmit: Boolean(valid && userId && workflow.can_submit && (canManage || isWriter)
      && workflow.released_at && (!current || (validVersion && ["approved", "changes_requested", "rejected"].includes(current.decision)))),
    canReview: Boolean(valid && validVersion && userId && workflow.can_review
      && current?.reviewer_id === userId && current.decision === "pending"),
    canPublish: Boolean(valid && validVersion && userId && workflow.can_publish
      && current?.decision === "approved" && workflow.published_version_id !== current.id),
  };
}
