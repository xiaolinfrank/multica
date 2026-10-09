import type { CockpitMeetingWorkflow, CockpitReviewerHandoffCommand } from "../types";

/** The immutable receipt, rather than the latest reviewer, acknowledges a retryable handoff. */
export function acknowledgedCockpitReviewerHandoff(workflow: CockpitMeetingWorkflow, command: CockpitReviewerHandoffCommand) {
  const handoff = workflow.reviewer_handoffs.find((entry) => entry.handoff_key === command.handoff_key);
  if (!workflow.enabled || !handoff || handoff.to_reviewer_id !== command.reviewer_id || handoff.reason !== command.reason.trim()
    || !handoff.id || !handoff.created_by || !handoff.created_at
    || handoff.from_reviewer_id === handoff.to_reviewer_id
    || handoff.revision !== command.expected_revision + 1 || handoff.revision > workflow.revision
    || (handoff.version_id === null
      ? handoff.from_review_issue !== null || handoff.to_review_issue !== null
      : !workflow.versions.some((version) => version.id === handoff.version_id)
        || !handoff.from_review_issue?.id || !handoff.to_review_issue?.id
        || handoff.from_review_issue.id === handoff.to_review_issue.id)) return null;
  return handoff;
}
