import { z } from "zod";

const id = z.string().min(1);
const count = z.number().int().nonnegative();
export const CockpitNodeChoiceSchema = z.object({ id, title: z.string(), project_id: id.nullable(), module_id: id.nullable(), code: z.string(), eligible: z.boolean(), reason: z.string() })
  .refine((node) => !node.eligible || Boolean(node.project_id && node.module_id && !node.reason), "Eligible work items require a verified project/module binding");
export const CockpitNodeChoicePageSchema = z.object({
  workspace_id: id, scope: z.object({ project_id: id.nullable(), module_id: id.nullable(), q: z.string(), eligible: z.boolean() }),
  items: z.array(CockpitNodeChoiceSchema).max(100), total: count, filtered_total: count, next_cursor: id.nullable(),
}).refine((page) => page.total >= page.filtered_total && page.filtered_total >= page.items.length
  && page.items.every((item) => (!page.scope.eligible || item.eligible) && (!page.scope.project_id || item.project_id === page.scope.project_id)
    && (!page.scope.module_id || item.module_id === page.scope.module_id)), "Node choices cross scope or exceed their counts");
export const CockpitMemberChoiceSchema = z.object({ id, title: z.string(), avatar_url: z.string().default(""), email: z.string().default(""), role: z.string() });
export const CockpitMemberChoicePageSchema = z.object({
  workspace_id: id, scope: z.object({ q: z.string(), ids: z.array(id).max(20) }),
  items: z.array(CockpitMemberChoiceSchema).max(100), total: count, filtered_total: count, next_cursor: id.nullable(),
}).refine((page) => page.total >= page.filtered_total && page.filtered_total >= page.items.length
  && (page.scope.ids.length === 0 || (page.scope.q === "" && page.next_cursor === null && page.items.every((item) => page.scope.ids.includes(item.id)))), "Member choices cross the requested identity scope");

const assigneeType = z.enum(["member", "agent", "squad"]);
export const CockpitAssigneeChoiceSchema = z.object({
  id, type: z.enum(["member", "agent", "squad", "unknown"]).catch("unknown"), title: z.string(), email: z.string().default(""), avatar_url: z.string().default(""),
  status: z.string(), runtime_bound: z.boolean().nullable().default(null), can_assign: z.boolean().default(false), reason: z.string().default(""),
}).transform((item) => {
  const knownStatus = item.type === "agent" ? ["idle", "working", "blocked", "error", "offline", "archived"].includes(item.status) : ["active", "archived"].includes(item.status);
  return item.type === "unknown" || !knownStatus || item.status === "archived" || item.reason !== "" || (item.type !== "member" && item.runtime_bound !== true)
    ? { ...item, can_assign: false } : item;
});
export const CockpitAssigneeChoicePageSchema = z.object({
  workspace_id: id, q: z.string(), kind: z.enum(["all", "member", "agent", "squad"]), selected_type: assigneeType.nullable(), selected_id: id.nullable(),
  items: z.array(CockpitAssigneeChoiceSchema).max(100), total: count, next_cursor: id.nullable(),
}).refine((page) => page.total >= page.items.length && ((page.selected_type === null) === (page.selected_id === null))
  && new Set(page.items.map((item) => `${item.type}:${item.id}`)).size === page.items.length
  && (!page.selected_id || (page.q === "" && page.kind === "all" && page.next_cursor === null && page.items.length <= 1 && page.items.every((item) => item.type === page.selected_type && item.id === page.selected_id)))
  && (page.kind === "all" || page.items.every((item) => item.type === page.kind)), "Assignee choices crossed the requested scope");
