import { z } from "zod";

// Directory responses (S7). Every field has a default or a catch: the panel
// shows a state, and a state it cannot read must degrade to "unknown" rather
// than take the whole response through parseWithFallback's empty fallback —
// losing a path that is actually there.

export const RunningAgentTaskSchema = z.object({
  task_id: z.string().default(""),
  issue_id: z.string().default(""),
  issue_identifier: z.string().default(""),
  status: z.string().default(""),
}).loose();

export const SharedCollabProjectSchema = z.object({
  workspace_id: z.string().default(""),
  workspace_slug: z.string().default(""),
  workspace_name: z.string().default(""),
  project_id: z.string().default(""),
  project_title: z.string().default(""),
}).loose();

export const NodeDirectorySyncResultSchema = z.object({
  status: z.string().default(""),
  directory_name: z.string().optional().catch(undefined),
  from_directory: z.string().optional().catch(undefined),
  to_directory: z.string().optional().catch(undefined),
  reason: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
}).loose();

export const PlanDirectoryStatusSchema = z.object({
  node_id: z.string().default(""),
  kind: z.enum(["project", "module", "work_item"]).catch("work_item"),
  project_id: z.string().default(""),
  project_collab_path: z.string().nullable().catch(null).default(null),
  directory_name: z.string().nullable().catch(null).default(null),
  expected_directory_name: z.string().nullable().catch(null).default(null),
  full_path: z.string().nullable().catch(null).default(null),
  status: z.string().default("invalid"),
  // Go writes a nil slice as `null`; an empty list must read as empty, not
  // take the whole status through the fallback.
  running_tasks: z.array(RunningAgentTaskSchema).catch([]).default([]),
  shared_collab_projects: z.array(SharedCollabProjectSchema).catch([]).default([]),
  error: z.string().optional().catch(undefined),
}).loose();

export const PlanDirectoryListSchema = z.object({
  items: z.array(PlanDirectoryStatusSchema).catch([]).default([]),
}).loose();

export const DirectoryFillItemSchema = z.object({
  node_id: z.string().default(""),
  code: z.string().default(""),
  name: z.string().default(""),
  kind: z.enum(["module", "work_item"]).catch("work_item"),
  action: z.string().default("none"),
  directory_name: z.string().optional().catch(undefined),
  full_path: z.string().optional().catch(undefined),
  status: z.string().default(""),
  reason: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
}).loose();

export const DirectoryFillResultSchema = z.object({
  applied: z.boolean().default(false),
  items: z.array(DirectoryFillItemSchema).catch([]).default([]),
  counts: z.record(z.string(), z.number()).catch({}).default({}),
  shared_collab_projects: z.array(SharedCollabProjectSchema).catch([]).default([]),
}).loose();

export const IssueDirectoryStatusSchema = z.object({
  issue_id: z.string().default(""),
  project_id: z.string().nullable().catch(null).default(null),
  project_collab_path: z.string().nullable().catch(null).default(null),
  directory_name: z.string().nullable().catch(null).default(null),
  full_path: z.string().nullable().catch(null).default(null),
  status: z.string().default("invalid"),
  // Go writes a nil slice as `null`; an empty list must read as empty, not
  // take the whole status through the fallback.
  running_tasks: z.array(RunningAgentTaskSchema).catch([]).default([]),
  shared_collab_projects: z.array(SharedCollabProjectSchema).catch([]).default([]),
  error: z.string().optional().catch(undefined),
}).loose();

export const IssueDirectoryEnsureResultSchema = z.object({
  directory_name: z.string().nullable().catch(null).default(null),
  full_path: z.string().nullable().catch(null).default(null),
  status: z.string().default("invalid"),
  exists: z.boolean().default(false),
  shared_collab_projects: z.array(SharedCollabProjectSchema).default([]),
  error: z.string().optional().catch(undefined),
}).loose();

/** The 409 body a structural write returns while an agent works in a folder. */
export const RunningAgentTasksRefusalSchema = z.object({
  code: z.literal("running_agent_tasks"),
  error: z.string().default(""),
  running_tasks: z.array(RunningAgentTaskSchema).default([]),
}).loose();

/** The two halves the sync endpoint answers with. */
export const NodeDirectorySyncResponseSchema = z.object({
  directory_sync: NodeDirectorySyncResultSchema.default({ status: "failed" }),
  directory: PlanDirectoryStatusSchema.optional(),
}).loose();
