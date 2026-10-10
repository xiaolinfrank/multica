import type { CockpitTask } from "./cockpit";
import type { CockpitArtifactHeader, CockpitArtifactVersionMetadata, CockpitAcceptanceHeader, CockpitAcceptanceRequestDetail } from "./cockpit-artifacts";

export interface CockpitArtifactNewProducerIssue {
  title: string; description: string; assignee_type?: "member" | "agent" | "squad" | null; assignee_id?: string | null;
  priority?: "none" | "urgent" | "high" | "medium" | "low"; due_date?: string | null;
}
export type CockpitArtifactProducerCommand = { expected_revision: number; command_key: string; reason: string } & (
  { issue_id: string; new_issue?: never } | { issue_id?: never; new_issue: CockpitArtifactNewProducerIssue }
);
export interface CockpitArtifactReviewerCommand { expected_revision: number; handoff_key: string; reviewer_id: string; reason: string }
export interface CockpitArtifactProducerAssignment {
  from_issue_identifier?: string; from_issue_title?: string; to_issue_identifier?: string; to_issue_title?: string; created_by_name?: string;
  id: string; artifact_id: string; command_key: string; from_issue_id: string; to_issue_id: string;
  reason: string; created_by: string; created_at: string; revision: number;
}
export interface CockpitArtifactReviewerHandoff {
  from_reviewer_name?: string; to_reviewer_name?: string; created_by_name?: string;
  id: string; artifact_id: string; handoff_key: string; from_reviewer_id: string; to_reviewer_id: string;
  version_id: string | null; version_number: number | null; from_review_issue_id: string | null; to_review_issue_id: string | null;
  reason: string; created_by: string; created_at: string; revision: number;
}
export interface CockpitArtifactProducerPage { workspace_id: string; artifact_id: string; items: CockpitArtifactProducerAssignment[]; total: number; next_cursor: string | null }
export interface CockpitArtifactProducerResponse { workspace_id: string; artifact: CockpitArtifactHeader; assignment: CockpitArtifactProducerAssignment; to_issue: CockpitTask }
export interface CockpitArtifactHandoffPage { workspace_id: string; artifact_id: string; items: CockpitArtifactReviewerHandoff[]; total: number; next_cursor: string | null }
export interface CockpitArtifactHandoffResponse { workspace_id: string; artifact: CockpitArtifactHeader; version: CockpitArtifactVersionMetadata | null; handoff: CockpitArtifactReviewerHandoff }

export type CockpitArtifactReferencePurpose = "input" | "output" | "evidence" | "reference";
export type CockpitArtifactReferenceKind = "node" | "meeting";
export interface CockpitArtifactReferenceCreate { reference_key: string; version_id: string; purpose: CockpitArtifactReferencePurpose }
export interface CockpitArtifactNodeReferenceCreate extends CockpitArtifactReferenceCreate { node_id: string }
export interface CockpitArtifactMeetingReferenceCreate extends CockpitArtifactReferenceCreate { meeting_id: string }
export interface CockpitArtifactReference {
  id: string; artifact_id: string; version_id: string; version_number: number; content_hash: string; reference_key: string;
  node_id?: string; meeting_id?: string; target_label: string; purpose: string;
  created_by: string; created_at: string; removed_by: string | null; removed_at: string | null;
}
export interface CockpitArtifactReferencePage { workspace_id: string; artifact_id: string; items: CockpitArtifactReference[]; total: number; next_cursor: string | null }
export interface CockpitArtifactReferenceResponse { workspace_id: string; reference: CockpitArtifactReference }
export interface CockpitMeetingArtifactReferencePage {
  workspace_id: string; meeting_id: string; include_removed: boolean;
  items: (CockpitArtifactReference & { artifact_title: string })[]; total: number; next_cursor: string | null;
}

export interface CockpitAcceptanceReviewerHandoff {
  from_reviewer_name?: string; to_reviewer_name?: string; created_by_name?: string;
  id: string; node_id: string; request_id: string; handoff_key: string; from_reviewer_id: string; to_reviewer_id: string;
  from_review_issue_id: string; to_review_issue_id: string; reason: string; created_by: string; created_at: string; revision: number;
}
export interface CockpitAcceptanceHandoffPage { workspace_id: string; node_id: string; items: CockpitAcceptanceReviewerHandoff[]; total: number; next_cursor: string | null }
export interface CockpitAcceptanceHandoffResponse { workspace_id: string; acceptance: CockpitAcceptanceHeader; request: CockpitAcceptanceRequestDetail; handoff: CockpitAcceptanceReviewerHandoff }
