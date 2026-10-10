import { z } from "zod";
const common = { code: z.string(), title: z.string(), available: z.boolean(), can_unlink: z.boolean() };
export const CockpitIssueNodeReferenceSchema = z.object({ ...common, node_id: z.string().min(1),
  relation: z.string().transform((value): "reference" | "unknown" => value === "reference" ? value : "unknown"),
}).transform((value) => ({ ...value, can_unlink: value.relation === "reference" && value.can_unlink }));
export const CockpitIssueMeetingReferenceSchema = z.object({ ...common, meeting_id: z.string().min(1), meet_date: z.string(),
  role: z.string(), roles: z.array(z.string()), required_roles: z.array(z.string()),
}).transform((value) => ({ ...value, can_unlink: value.can_unlink && value.required_roles.length === 0 }));
function page<T extends z.ZodType>(item: T, id: (value: z.output<T>) => string) {
  return z.object({ workspace_id: z.string().min(1), issue_id: z.string().min(1), items: z.array(item).max(100),
    total: z.number().int().nonnegative(), next_cursor: z.string().min(1).nullable(),
  }).refine((value) => value.items.length <= value.total && new Set(value.items.map(id)).size === value.items.length
    && (!value.next_cursor || value.items.length > 0));
}
export const CockpitIssueNodeReferencesSchema = page(CockpitIssueNodeReferenceSchema, (value) => value.node_id);
export const CockpitIssueMeetingReferencesSchema = page(CockpitIssueMeetingReferenceSchema, (value) => value.meeting_id);
export const CockpitIssueReferenceRemovalSchema = z.object({ workspace_id: z.string().min(1), issue_id: z.string().min(1),
  kind: z.enum(["node", "meeting"]), target_id: z.string().min(1), removed: z.literal(true) });
