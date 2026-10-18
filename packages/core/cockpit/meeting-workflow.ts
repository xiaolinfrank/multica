import type { CockpitMeetingWorkflow } from "../types";

/** Superseded review tasks remain evidence owned by this meeting's workflow. */
export function cockpitWorkflowRequiredIssueRoles(workflow: CockpitMeetingWorkflow): Map<string, string[]> {
  const required = new Map<string, string[]>();
  if (!workflow.enabled) return required;
  if (workflow.minutes_issue?.id) required.set(workflow.minutes_issue.id, ["minutes"]);
  const addReview = (issueId: string | undefined) => {
    if (issueId) required.set(issueId, [...new Set([...(required.get(issueId) ?? []), "review"])]);
  };
  for (const version of workflow.versions) addReview(version.review_issue.id);
  for (const handoff of workflow.reviewer_handoffs) {
    addReview(handoff.from_review_issue?.id);
    addReview(handoff.to_review_issue?.id);
  }
  return required;
}

/** Capability hints are combined with the actual workflow facts and the designated human reviewer. */
export function cockpitWorkflowActions(workflow: CockpitMeetingWorkflow, userId: string) {
  const current = workflow.versions.find((version) => version.id === workflow.current_version_id) ?? null;
  const valid = Boolean(workflow.enabled && workflow.minutes_issue?.id && workflow.reviewer_id && workflow.revision > 0
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
    canReassignReviewer: Boolean(canManage && workflow.can_reassign_reviewer
      && (!current || (validVersion && ["pending", "approved", "changes_requested", "rejected"].includes(current.decision)))),
    canRelease: canManage && Boolean(workflow.ended_at && workflow.materials_ready && !workflow.released_at
      && workflow.minutes_issue?.status === "backlog"),
    canSubmit: Boolean(valid && userId && workflow.can_submit && (canManage || isWriter)
      && (!current || (validVersion && ["approved", "changes_requested", "rejected"].includes(current.decision)))),
    canReview: Boolean(valid && validVersion && userId && workflow.can_review
      && current?.reviewer_id === userId && current.decision === "pending"),
    canPublish: Boolean(valid && validVersion && userId && workflow.can_publish
      && current?.decision === "approved" && workflow.published_version_id !== current.id),
  };
}
