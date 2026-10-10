import { CockpitTaskSchema } from "@multica/core/api/schemas";
import type { CockpitArtifactHeader, CockpitArtifactVersionDetail, CockpitArtifactVersionMetadata, CockpitAcceptanceRequestDetail } from "@multica/core/types";

export const ARTIFACT_CREATION_KEY = "10000000-0000-4000-8000-000000000001";
export const ARTIFACT_SUBMISSION_KEY = "20000000-0000-4000-8000-000000000001";
export const ACCEPTANCE_REQUEST_KEY = "30000000-0000-4000-8000-000000000001";
export const ARTIFACT_FINGERPRINT = "a".repeat(64);
export function artifactVersionFixture(overrides: Partial<CockpitArtifactVersionMetadata> = {}): CockpitArtifactVersionMetadata {
  return { id: "version-1", artifact_id: "artifact-1", version_number: 1, submission_key: ARTIFACT_SUBMISSION_KEY, revision: 1,
    payload_kind: "text", source_attachment_id: null, filename: "", content_type: "text/markdown", size_bytes: 12, content_hash: ARTIFACT_FINGERPRINT,
    capture_status: "ready", capture_error_code: "", capture_error: "", decision: "pending", reviewer_id: "reviewer-1",
    review_issue: CockpitTaskSchema.parse({ id: "review-1", identifier: "PMO-2", title: "Review fixed version", status: "todo", status_category: "unstarted", assignee_type: "member", assignee_id: "reviewer-1" }),
    submitted_by_type: "member", submitted_by_id: "author-1", created_at: "2026-10-10T01:00:00Z", reviewed_at: null, has_feedback: false,
    can_review: true, can_retry_capture: false, ...overrides };
}
export function artifactFixture(overrides: Partial<CockpitArtifactHeader> = {}): CockpitArtifactHeader {
  return { id: "artifact-1", workspace_id: "ws-1", creation_key: ARTIFACT_CREATION_KEY, node_id: "node-1", node_label: "Interface delivery", project_id: "project-1", module_id: "module-1",
    source_issue: CockpitTaskSchema.parse({ id: "source-1", identifier: "PMO-1", title: "Prepare report", status: "done", status_category: "done" }),
    title: "Delivery report", description: "", status: "pending", revision: 2, reviewer_id: "reviewer-1", archived_at: null,
    current_version: artifactVersionFixture(), approved_version: null, version_count: 1, can_edit: true, can_submit: false, can_archive: false, ...overrides };
}
export function artifactVersionDetailFixture(overrides: Partial<CockpitArtifactVersionDetail> = {}): CockpitArtifactVersionDetail {
  return { workspace_id: "ws-1", artifact_id: "artifact-1", version: artifactVersionFixture(), content: "Fixed report", feedback: "", download_url: null, ...overrides };
}
export function acceptanceFixture(overrides: Partial<CockpitAcceptanceRequestDetail> = {}): CockpitAcceptanceRequestDetail {
  const version = artifactVersionFixture({ decision: "approved", reviewed_at: "2026-10-10T02:00:00Z", can_review: false });
  return { workspace_id: "ws-1", node_id: "node-1", request: { id: "acceptance-1", node_id: "node-1", request_key: ACCEPTANCE_REQUEST_KEY,
    revision: 1, criteria_revision: 1, evidence_hash: ARTIFACT_FINGERPRINT, reviewer_id: "reviewer-1", review_issue: CockpitTaskSchema.parse({ id: "acceptance-review-1", title: "Accept delivery", status: "todo" }),
    decision: "pending", has_feedback: false, created_by: "author-1", created_at: "2026-10-10T03:00:00Z", reviewed_at: null, can_review: true, supersedes_request_id: null, superseded_at: null },
    evidence: [{ criterion: { id: "criterion-1", title: "Interface passes", description: "", revision: 1, position: 0 }, versions: [version] }],
    note: "Review the fixed evidence", feedback: "", definition_changed: false, evidence_outdated: false, ...overrides };
}
