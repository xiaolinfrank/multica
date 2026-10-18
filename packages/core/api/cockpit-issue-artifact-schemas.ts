import { z } from "zod";

const id = z.string().min(1);
export const CockpitIssueFormalReviewSchema = z.object({
  kind: id, stage: id, node_id: id, artifact_id: id.nullable(), version_id: id.nullable(), request_id: id.nullable(),
}).refine((row) => (row.kind !== "artifact_version" || (row.artifact_id !== null && row.version_id !== null && row.request_id === null))
  && (row.kind !== "acceptance_request" || (row.artifact_id === null && row.version_id === null && row.request_id !== null)));
export const CockpitIssueArtifactContextSchema = z.object({
  kind: id, id, roles: z.array(id).min(1), artifact_id: id.nullable(), artifact_title: z.string(),
  version_id: id.nullable(), version_number: z.number().int().positive().nullable(),
  node_id: id, node_label: z.string(), request_id: id.nullable(), decision: z.string(),
  reviewer_id: id.nullable(), is_current_review: z.boolean().default(false),
}).refine((row) => new Set(row.roles).size === row.roles.length
  && (row.version_id === null) === (row.version_number === null)
  && (!row.is_current_review || Boolean(row.reviewer_id))
  && (row.kind !== "artifact" || (row.id === row.artifact_id && row.version_id === null && row.request_id === null))
  && (row.kind !== "artifact_version" || (row.id === row.version_id && row.artifact_id !== null && row.request_id === null))
  && (row.kind !== "acceptance_request" || (row.id === row.request_id && row.artifact_id === null && row.version_id === null)));

export const CockpitIssueArtifactContextPageSchema = z.object({
  formal_review: CockpitIssueFormalReviewSchema.nullable().default(null),
  workspace_id: id, issue_id: id, items: z.array(CockpitIssueArtifactContextSchema).max(100),
  total: z.number().int().nonnegative(), next_cursor: id.nullable(),
}).refine((page) => page.total >= page.items.length
  && new Set(page.items.map((row) => `${row.kind}:${row.id}`)).size === page.items.length);
