import { z } from "zod";

const id = z.string().min(1);
const revision = z.number().int().nonnegative().nullable();
const availability = z.enum(["available", "unavailable", "unknown"]).catch("unknown");
export const IssueOperationFieldSchema = z.object({
  state: z.enum(["allowed", "blocked", "unknown"]).catch("unknown"),
  reason_codes: z.array(id),
});
export const IssueStatusOperationFieldSchema = IssueOperationFieldSchema.extend({
  allowed_categories: z.array(id).max(4),
}).refine((value) => new Set(value.allowed_categories).size === value.allowed_categories.length
  && (value.state === "allowed" || value.allowed_categories.length === 0));
export const IssueOperationTargetSchema = z.object({
  kind: id, label: z.string(), purpose: id,
  issue_id: id.optional(), node_id: id.optional(), meeting_id: id.optional(),
  action_id: id.optional(), artifact_id: id.optional(), version_id: id.optional(),
  request_id: id.optional(), view: z.string().optional(),
}).refine((target) => {
  switch (target.kind) {
    case "issue": return Boolean(target.issue_id);
    case "node": return Boolean(target.node_id);
    case "meeting": return Boolean(target.meeting_id);
    case "artifact": return Boolean(target.artifact_id);
    case "artifact_version": return Boolean(target.artifact_id && target.version_id);
    case "acceptance_request": return Boolean(target.node_id && target.request_id);
    default: return true;
  }
});
const targets = { targets: z.array(IssueOperationTargetSchema).max(3), targets_total: z.number().int().nonnegative() };
export const IssueOperationBasisSchema = z.object({
  issue_id: id, availability, issue_revision: revision, status: IssueStatusOperationFieldSchema,
  assignee: IssueOperationFieldSchema, scope: IssueOperationFieldSchema,
  parent: IssueOperationFieldSchema, primary: IssueOperationFieldSchema,
  delete: IssueOperationFieldSchema, execution: IssueOperationFieldSchema, ...targets,
}).refine((value) => value.targets_total >= value.targets.length
  && (value.availability === "available" || (value.issue_revision === null && value.targets.length === 0 && value.targets_total === 0
    && [value.status, value.assignee, value.scope, value.parent, value.primary, value.delete, value.execution].every((field) => field.state === "unknown"))));
export const IssueOperationBasisPageSchema = z.object({
  workspace_id: id, schema_version: z.literal(1),
  generated_at: z.string().datetime({ offset: true }),
  items: z.array(IssueOperationBasisSchema).min(1).max(100),
}).refine((page) => new Set(page.items.map((item) => item.issue_id)).size === page.items.length);
export const ContainerOperationBasisSchema = z.object({
  workspace_id: id, schema_version: z.literal(1), generated_at: z.string().datetime({ offset: true }),
  resource_kind: z.enum(["node", "project", "module"]), resource_id: id,
  availability, resource_revision: revision, delete: IssueOperationFieldSchema,
  structural_edit: IssueOperationFieldSchema, add_child: IssueOperationFieldSchema, ...targets,
}).refine((value) => value.targets_total >= value.targets.length
  && (value.availability === "available" || (value.resource_revision === null && value.targets.length === 0 && value.targets_total === 0
    && [value.delete, value.structural_edit, value.add_child].every((field) => field.state === "unknown"))));
