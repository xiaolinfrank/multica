import { z } from "zod";
import { CockpitTaskSchema } from "./schemas";
import { CockpitArtifactHeaderSchema, CockpitArtifactVersionMetadataSchema, CockpitAcceptanceHeaderSchema, CockpitAcceptanceRequestDetailSchema } from "./cockpit-artifact-schemas";

const id = z.string().min(1);
const key = z.string().uuid();
const time = z.string().datetime({ offset: true });
const revision = z.number().int().positive();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const receipt = { id, reason: z.string().min(1), created_by: id, created_at: time, revision };

export const CockpitArtifactProducerAssignmentSchema = z.object({ ...receipt, artifact_id: id, command_key: key, from_issue_id: id, to_issue_id: id,
  from_issue_identifier: z.string().default(""), from_issue_title: z.string().default(""), to_issue_identifier: z.string().default(""), to_issue_title: z.string().default(""), created_by_name: z.string().default(""),
})
  .refine((entry) => entry.from_issue_id !== entry.to_issue_id);
export const CockpitArtifactReviewerHandoffSchema = z.object({
  from_reviewer_name: z.string().default(""), to_reviewer_name: z.string().default(""), created_by_name: z.string().default(""),
  ...receipt, artifact_id: id, handoff_key: key, from_reviewer_id: id, to_reviewer_id: id,
  version_id: id.nullable(), version_number: revision.nullable(), from_review_issue_id: id.nullable(), to_review_issue_id: id.nullable(),
}).refine((entry) => entry.from_reviewer_id !== entry.to_reviewer_id
  && (entry.version_id === null) === (entry.version_number === null)
  && (entry.from_review_issue_id === null) === (entry.to_review_issue_id === null)
  && (!entry.from_review_issue_id || (Boolean(entry.version_id) && entry.from_review_issue_id !== entry.to_review_issue_id)));

function artifactPage<T extends { id: string; artifact_id: string }>(item: z.ZodType<T>) {
  return z.object({ workspace_id: id, artifact_id: id, items: z.array(item).max(100), total: z.number().int().nonnegative(), next_cursor: id.nullable() })
    .refine((page) => page.total >= page.items.length && new Set(page.items.map((entry) => entry.id)).size === page.items.length
      && page.items.every((entry) => entry.artifact_id === page.artifact_id));
}
export const CockpitArtifactProducerPageSchema = artifactPage(CockpitArtifactProducerAssignmentSchema);
export const CockpitArtifactHandoffPageSchema = artifactPage(CockpitArtifactReviewerHandoffSchema);
export const CockpitArtifactProducerResponseSchema = z.object({ workspace_id: id, artifact: CockpitArtifactHeaderSchema, assignment: CockpitArtifactProducerAssignmentSchema, to_issue: CockpitTaskSchema })
  .refine((value) => value.artifact.workspace_id === value.workspace_id && value.assignment.artifact_id === value.artifact.id && value.assignment.to_issue_id === value.to_issue.id);
export const CockpitArtifactHandoffResponseSchema = z.object({ workspace_id: id, artifact: CockpitArtifactHeaderSchema, version: CockpitArtifactVersionMetadataSchema.nullable(), handoff: CockpitArtifactReviewerHandoffSchema })
  .refine((value) => value.artifact.workspace_id === value.workspace_id && value.handoff.artifact_id === value.artifact.id
    && (value.version?.id ?? null) === value.handoff.version_id && (!value.version || value.version.artifact_id === value.artifact.id));

export const CockpitArtifactReferenceSchema = z.object({
  id, artifact_id: id, version_id: id, version_number: revision, content_hash: hash, reference_key: key,
  node_id: id.optional(), meeting_id: id.optional(), target_label: z.string(), purpose: z.string(),
  created_by: id, created_at: time, removed_by: id.nullable(), removed_at: time.nullable(),
}).refine((value) => Boolean(value.node_id) !== Boolean(value.meeting_id)
  && (value.removed_by === null) === (value.removed_at === null));
export const CockpitArtifactReferencePageSchema = artifactPage(CockpitArtifactReferenceSchema);
export const CockpitArtifactReferenceResponseSchema = z.object({ workspace_id: id, reference: CockpitArtifactReferenceSchema });
export const CockpitMeetingArtifactReferencePageSchema = z.object({
  workspace_id: id, meeting_id: id, include_removed: z.boolean(),
  items: z.array(CockpitArtifactReferenceSchema.and(z.object({ artifact_title: z.string() }))).max(100),
  total: z.number().int().nonnegative(), next_cursor: id.nullable(),
}).refine((page) => page.total >= page.items.length && new Set(page.items.map((entry) => entry.id)).size === page.items.length
  && page.items.every((entry) => entry.meeting_id === page.meeting_id && (page.include_removed || entry.removed_at === null)));

export const CockpitAcceptanceReviewerHandoffSchema = z.object({
  from_reviewer_name: z.string().default(""), to_reviewer_name: z.string().default(""), created_by_name: z.string().default(""),
  ...receipt, node_id: id, request_id: id, handoff_key: key, from_reviewer_id: id, to_reviewer_id: id, from_review_issue_id: id, to_review_issue_id: id,
}).refine((value) => value.from_reviewer_id !== value.to_reviewer_id && value.from_review_issue_id !== value.to_review_issue_id);
export const CockpitAcceptanceHandoffPageSchema = z.object({
  workspace_id: id, node_id: id, items: z.array(CockpitAcceptanceReviewerHandoffSchema).max(100), total: z.number().int().nonnegative(), next_cursor: id.nullable(),
}).refine((page) => page.total >= page.items.length && new Set(page.items.map((entry) => entry.id)).size === page.items.length
  && page.items.every((entry) => entry.node_id === page.node_id));
export const CockpitAcceptanceHandoffResponseSchema = z.object({
  workspace_id: id, acceptance: CockpitAcceptanceHeaderSchema, request: CockpitAcceptanceRequestDetailSchema, handoff: CockpitAcceptanceReviewerHandoffSchema,
}).refine((value) => value.acceptance.workspace_id === value.workspace_id && value.request.workspace_id === value.workspace_id
  && value.acceptance.node_id === value.request.node_id && value.handoff.node_id === value.acceptance.node_id && value.handoff.request_id === value.request.request.id);
