import type { CockpitTask } from "./cockpit";

export type CockpitArtifactPayload = { kind: "text"; content: string } | { kind: "attachment"; attachment_id: string };
export interface CockpitArtifactCreate { creation_key: string; node_id: string; source_issue_id: string; title: string; description: string; reviewer_id: string }
export interface CockpitArtifactEdit { expected_revision: number; title: string; description: string }
export interface CockpitArtifactSubmit { expected_revision: number; submission_key: string; producer_issue_id: string; source_meeting_id?: string; source_minutes_version_id?: string; payload: CockpitArtifactPayload }
export interface CockpitArtifactReview { expected_revision: number; decision: "approved" | "changes_requested" | "rejected"; feedback: string }
export interface CockpitArtifactPageQuery { cursor?: string; page_size?: number }
export interface CockpitArtifactQuery extends CockpitArtifactPageQuery { project_id?: string; module_id?: string; node_id?: string; source_issue_id?: string; ids?: string[]; q?: string; status?: string; relation?: "owned" | "referenced" | "all" }
export interface CockpitArtifactScope { project_id: string | null; module_id: string | null; node_id: string | null; source_issue_id: string | null; ids: string[]; q: string; status: string; relation: string }

export interface CockpitArtifactVersionMetadata {
  id: string; artifact_id: string; version_number: number; submission_key: string; revision: number;
  producer_issue_id: string; producer_issue_identifier: string; producer_issue_title: string; producer_run_id: string | null;
  source_meeting_id: string | null; source_meeting_title: string; source_minutes_version_id: string | null; source_minutes_version_number: number | null;
  payload_kind: string; source_attachment_id: string | null; filename: string; content_type: string; size_bytes: number | null; content_hash: string | null;
  capture_status: string; capture_error_code: string; capture_error: string; decision: string; reviewer_id: string; review_issue: CockpitTask | null;
  submitted_by_type: string; submitted_by_id: string; created_at: string; reviewed_at: string | null; has_feedback: boolean;
  can_review: boolean; can_retry_capture: boolean;
}
export interface CockpitArtifactHeader {
  file_capture_available: boolean; file_capture_unavailable_reason: string;
  id: string; workspace_id: string; creation_key: string; node_id: string; node_label: string; project_id: string; module_id: string;
  source_issue: CockpitTask; producer_issue: CockpitTask; created_by: string; title: string; description: string; status: string; revision: number; reviewer_id: string; archived_at: string | null;
  current_version: CockpitArtifactVersionMetadata | null; approved_version: CockpitArtifactVersionMetadata | null; version_count: number;
  evidence_version: CockpitArtifactVersionMetadata | null;
  can_edit: boolean; can_submit: boolean; can_archive: boolean; can_restore: boolean; can_assign_producer: boolean; can_reassign_reviewer: boolean; can_reference: boolean;
}
export interface CockpitArtifactPage { workspace_id: string; scope: CockpitArtifactScope; items: CockpitArtifactHeader[]; total: number; filtered_total: number; next_cursor: string | null; can_create: boolean }
export interface CockpitArtifactVersionPage { workspace_id: string; artifact_id: string; artifact_revision: number; items: CockpitArtifactVersionMetadata[]; total: number; next_cursor: string | null }
export interface CockpitArtifactVersionDetail { workspace_id: string; artifact_id: string; version: CockpitArtifactVersionMetadata; content: string | null; feedback: string; download_url: string | null; content_available: boolean; content_unavailable_reason: string }
export interface CockpitArtifactVersionCommandResponse { workspace_id: string; artifact: CockpitArtifactHeader; version: CockpitArtifactVersionDetail }
export interface CockpitArtifactSourceAttachment { id: string; source_issue_id: string; filename: string; content_type: string; size_bytes: number; created_at: string }
export interface CockpitArtifactSourceAttachmentQuery extends CockpitArtifactPageQuery { q?: string }
export interface CockpitArtifactSourceAttachmentPage { workspace_id: string; artifact_id: string; producer_issue_id: string; q: string; items: CockpitArtifactSourceAttachment[]; total: number; filtered_total: number; next_cursor: string | null }
export interface CockpitArtifactDownloadLink { workspace_id: string; artifact_id: string; version_id: string; url: string; expires_at: string }

export interface CockpitAcceptanceCriterionInput { id: string; title: string; description: string }
export interface CockpitAcceptanceCriterion extends CockpitAcceptanceCriterionInput { revision: number; position: number }
export interface CockpitAcceptanceCriteriaUpdate { expected_revision: number; criteria: CockpitAcceptanceCriterionInput[] }
export interface CockpitAcceptanceCriteriaView { workspace_id: string; node_id: string; revision: number; items: CockpitAcceptanceCriterion[]; max_items: number; can_edit: boolean }
export interface CockpitAcceptanceEvidenceInput { criterion_id: string; version_ids: string[] }
export interface CockpitAcceptanceRequestCreate { request_key: string; expected_criteria_revision: number; reviewer_id: string; evidence: CockpitAcceptanceEvidenceInput[]; note: string; supersedes_request_id?: string }
export interface CockpitAcceptanceRequestMetadata {
  id: string; node_id: string; request_key: string; revision: number; criteria_revision: number; evidence_hash: string;
  reviewer_id: string; review_issue: CockpitTask; decision: string; has_feedback: boolean; created_by: string; created_at: string; reviewed_at: string | null; can_review: boolean;
  supersedes_request_id: string | null; superseded_at: string | null;
}
export interface CockpitAcceptanceHeader {
  workspace_id: string; node_id: string; criteria_revision: number; current_request: CockpitAcceptanceRequestMetadata | null;
  last_approved_request: CockpitAcceptanceRequestMetadata | null; request_count: number; can_edit_criteria: boolean; can_request: boolean; needs_reacceptance: boolean; can_reassign_reviewer: boolean;
}
export interface CockpitAcceptanceRequestPage { workspace_id: string; node_id: string; items: CockpitAcceptanceRequestMetadata[]; total: number; next_cursor: string | null }
export interface CockpitAcceptanceEvidence { criterion: CockpitAcceptanceCriterion; versions: CockpitArtifactVersionMetadata[] }
export interface CockpitAcceptanceRequestDetail {
  workspace_id: string; node_id: string; request: CockpitAcceptanceRequestMetadata; evidence: CockpitAcceptanceEvidence[];
  note: string; feedback: string; definition_changed: boolean; evidence_outdated: boolean;
  evidence_available: boolean; evidence_unavailable_reason: string;
}
