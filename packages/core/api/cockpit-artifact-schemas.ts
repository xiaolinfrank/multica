import { z } from "zod";
import { CockpitTaskSchema } from "./schemas";

const id = z.string().min(1);
const key = z.string().uuid();
const count = z.number().int().nonnegative();
const revision = z.number().int().positive();
const time = z.string().datetime({ offset: true });
const nullableTime = time.nullable();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const capability = z.boolean().catch(false).default(false);

/** Only a fresh server-authorized download link may leave the app's authenticated client. */
export function validCockpitArtifactDownloadURL(value: string, artifactId: string, versionId: string): boolean {
  if (!value || value.trim() !== value || Array.from(value).some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127) || value.startsWith("//")) return false;
  try {
    if (value.startsWith("/")) {
      const parsed = new URL(value, "https://artifact.invalid");
      return parsed.origin === "https://artifact.invalid" && parsed.pathname === `/api/cockpit/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/download` && !parsed.hash;
    }
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password && !parsed.hash;
  } catch { return false; }
}

export const CockpitArtifactVersionMetadataSchema = z.object({
  id, artifact_id: id, version_number: revision, submission_key: key, revision,
  payload_kind: z.string(), source_attachment_id: id.nullable(), filename: z.string().default(""), content_type: z.string().default(""),
  size_bytes: count.nullable(), content_hash: hash.nullable(), capture_status: z.string(), capture_error_code: z.string().default(""), capture_error: z.string().default(""),
  decision: z.string(), reviewer_id: id, review_issue: CockpitTaskSchema.nullable(), submitted_by_type: z.string(), submitted_by_id: id,
  created_at: time, reviewed_at: nullableTime, has_feedback: z.boolean().default(false), can_review: capability, can_retry_capture: capability,
}).refine((version) => version.capture_status !== "ready" || (version.content_hash !== null && version.size_bytes !== null), "Ready versions require a verified fingerprint and size")
  .refine((version) => !["pending", "approved", "changes_requested", "rejected"].includes(version.decision) || (version.capture_status === "ready" && version.review_issue !== null), "A formal decision requires a fixed payload and review issue");

export const CockpitArtifactHeaderSchema = z.object({
  id, workspace_id: id, creation_key: key, node_id: id, node_label: z.string().default(""), project_id: id, module_id: id,
  source_issue: CockpitTaskSchema, title: z.string(), description: z.string().default(""), status: z.string().default("unknown"), revision, reviewer_id: id, archived_at: nullableTime,
  current_version: CockpitArtifactVersionMetadataSchema.nullable(), approved_version: CockpitArtifactVersionMetadataSchema.nullable(), version_count: count,
  can_edit: capability, can_submit: capability, can_archive: capability,
}).refine((artifact) => (!artifact.current_version || artifact.current_version.artifact_id === artifact.id)
  && (!artifact.approved_version || (artifact.approved_version.artifact_id === artifact.id && artifact.approved_version.decision === "approved")), "Artifact pins must identify this artifact")
  .refine((artifact) => artifact.version_count >= Number(Boolean(artifact.current_version || artifact.approved_version)), "Version count is inconsistent");

export const CockpitArtifactScopeSchema = z.object({ project_id: id.nullable(), module_id: id.nullable(), node_id: id.nullable(), source_issue_id: id.nullable(), q: z.string(), status: z.string() });
export const CockpitArtifactPageSchema = z.object({
  workspace_id: id, scope: CockpitArtifactScopeSchema, items: z.array(CockpitArtifactHeaderSchema).max(100), total: count, filtered_total: count, next_cursor: id.nullable(), can_create: capability,
}).refine((page) => page.total >= page.filtered_total && page.filtered_total >= page.items.length && page.items.every((item) => item.workspace_id === page.workspace_id), "Artifact page scope or counts are inconsistent");

export const CockpitArtifactVersionPageSchema = z.object({
  workspace_id: id, artifact_id: id, artifact_revision: revision, items: z.array(CockpitArtifactVersionMetadataSchema).max(100), total: count, next_cursor: id.nullable(),
}).refine((page) => page.total >= page.items.length && page.items.every((item) => item.artifact_id === page.artifact_id), "Version page scope or counts are inconsistent");

export const CockpitArtifactVersionDetailSchema = z.object({
  workspace_id: id, artifact_id: id, version: CockpitArtifactVersionMetadataSchema, content: z.string().nullable(), feedback: z.string(), download_url: z.string().nullable(),
}).refine((detail) => detail.version.artifact_id === detail.artifact_id, "Version does not belong to this artifact")
  .refine((detail) => detail.version.payload_kind !== "text" || detail.content !== null, "Text versions require their fixed body")
  .refine((detail) => detail.version.payload_kind !== "attachment" || detail.content === null, "File versions must not invent a text body")
  .refine((detail) => detail.download_url === null || (detail.version.payload_kind === "attachment" && detail.version.capture_status === "ready"
    && validCockpitArtifactDownloadURL(detail.download_url, detail.artifact_id, detail.version.id)), "Unsafe or unfrozen artifact download URL");

export const CockpitArtifactVersionCommandResponseSchema = z.object({
  workspace_id: id, artifact: CockpitArtifactHeaderSchema, version: CockpitArtifactVersionDetailSchema,
}).refine((response) => response.artifact.workspace_id === response.workspace_id && response.version.workspace_id === response.workspace_id
  && response.artifact.id === response.version.artifact_id, "Artifact command receipt crosses scope");

export const CockpitArtifactSourceAttachmentSchema = z.object({ id, source_issue_id: id, filename: z.string(), content_type: z.string(), size_bytes: count, created_at: time });
export const CockpitArtifactSourceAttachmentPageSchema = z.object({
  workspace_id: id, artifact_id: id, source_issue_id: id, q: z.string(), items: z.array(CockpitArtifactSourceAttachmentSchema).max(100),
  total: count, filtered_total: count, next_cursor: id.nullable(),
}).refine((page) => page.total >= page.filtered_total && page.filtered_total >= page.items.length && page.items.every((item) => item.source_issue_id === page.source_issue_id), "Source attachment page crosses scope or exceeds counts");
export const CockpitArtifactDownloadLinkSchema = z.object({ workspace_id: id, artifact_id: id, version_id: id, url: z.string(), expires_at: time })
  .refine((link) => validCockpitArtifactDownloadURL(link.url, link.artifact_id, link.version_id), "Unsafe artifact download link");

export const CockpitAcceptanceCriterionSchema = z.object({ id, title: z.string(), description: z.string(), revision, position: count });
export const CockpitAcceptanceCriteriaViewSchema = z.object({
  workspace_id: id, node_id: id, revision: count, items: z.array(CockpitAcceptanceCriterionSchema).max(50), max_items: z.number().int().positive().max(50), can_edit: capability,
}).refine((view) => view.items.length <= view.max_items && new Set(view.items.map((item) => item.id)).size === view.items.length, "Acceptance criteria exceed limits or repeat identities");

export const CockpitAcceptanceRequestMetadataSchema = z.object({
  id, node_id: id, request_key: key, revision, criteria_revision: revision, evidence_hash: hash, reviewer_id: id, review_issue: CockpitTaskSchema,
  decision: z.string(), has_feedback: z.boolean().default(false), created_by: id, created_at: time, reviewed_at: nullableTime, can_review: capability,
  supersedes_request_id: id.nullable().default(null), superseded_at: nullableTime.default(null),
});
export const CockpitAcceptanceHeaderSchema = z.object({
  workspace_id: id, node_id: id, criteria_revision: count, current_request: CockpitAcceptanceRequestMetadataSchema.nullable(),
  last_approved_request: CockpitAcceptanceRequestMetadataSchema.nullable(), request_count: count,
  can_edit_criteria: capability, can_request: capability, needs_reacceptance: z.boolean(),
}).refine((header) => (!header.current_request || header.current_request.node_id === header.node_id)
  && (!header.last_approved_request || (header.last_approved_request.node_id === header.node_id && header.last_approved_request.decision === "approved")), "Acceptance pins cross scope");
export const CockpitAcceptanceRequestPageSchema = z.object({
  workspace_id: id, node_id: id, items: z.array(CockpitAcceptanceRequestMetadataSchema).max(100), total: count, next_cursor: id.nullable(),
}).refine((page) => page.total >= page.items.length && page.items.every((item) => item.node_id === page.node_id), "Acceptance page scope or counts are inconsistent");
export const CockpitAcceptanceEvidenceSchema = z.object({ criterion: CockpitAcceptanceCriterionSchema, versions: z.array(CockpitArtifactVersionMetadataSchema).min(1).max(20) })
  .refine((evidence) => evidence.versions.every((version) => version.decision === "approved" && version.capture_status === "ready")
    && new Set(evidence.versions.map((version) => version.id)).size === evidence.versions.length, "Acceptance evidence must identify distinct approved fixed versions");
export const CockpitAcceptanceRequestDetailSchema = z.object({
  workspace_id: id, node_id: id, request: CockpitAcceptanceRequestMetadataSchema, evidence: z.array(CockpitAcceptanceEvidenceSchema).min(1).max(50),
  note: z.string(), feedback: z.string(), definition_changed: z.boolean(), evidence_outdated: z.boolean(),
}).refine((detail) => detail.request.node_id === detail.node_id && new Set(detail.evidence.map((entry) => entry.criterion.id)).size === detail.evidence.length
  && new Set(detail.evidence.flatMap((entry) => entry.versions.map((version) => version.id))).size <= 200, "Acceptance snapshot scope or evidence limits are inconsistent");
