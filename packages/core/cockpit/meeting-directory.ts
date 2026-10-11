import { z } from "zod";
import { ApiError } from "../api/client";
import type { CockpitLifecycleCommandDetail } from "../types/cockpit-meeting-lifecycle";
import type { CockpitDirectoryCommandResult, CockpitDirectoryCreateInput, CockpitDirectoryRetryInput, CockpitDirectoryControlInput } from "../types/cockpit-meeting-directory";

export type CockpitDirectoryCommandInput = CockpitDirectoryCreateInput | CockpitDirectoryRetryInput | CockpitDirectoryControlInput;

/** Confirm the fixed receipt, never the operation's later progress or binding. */
export function cockpitDirectoryCommandAcknowledged(result: CockpitDirectoryCommandResult | CockpitLifecycleCommandDetail,
  action: string, body: CockpitDirectoryCommandInput, operationId?: string): boolean {
  if (result.command_key !== body.command_key || result.action !== action) return false;
  const receipt = "directory_operation_id" in result.receipt ? result.receipt : result.receipt.directory;
  if (!receipt || operationId && receipt.directory_operation_id !== operationId) return false;
  if (!["human", "delegated_task"].includes(receipt.grant.kind) || !["human", "task_token"].includes(receipt.principal.source)) return false;
  if (!["active", "paused", "needs_attention", "completed", "abandoned"].includes(receipt.state)) return false;
  if (action === "directory_prepare") return "relative_directory" in body && receipt.context_token === body.context_token
    && receipt.target.root_id === body.root_id && receipt.target.relative_directory === body.relative_directory.trim()
    && receipt.observed_binding.nas_dir === body.observed_nas_dir && receipt.observed_binding.revision === body.observed_binding_revision
    && body.expected_revision === body.observed_binding_revision && receipt.bind_after_base === body.bind_after_base
    && receipt.directory_step_ids.length > 0 && receipt.grant.command_key === body.command_key
    && receipt.grant.observed_binding.nas_dir === body.observed_nas_dir && receipt.grant.observed_binding.revision === body.observed_binding_revision;
  if (action === "directory_retry") return "step_ids" in body && receipt.context_token === body.context_token
    && receipt.reason === body.reason.trim() && receipt.grant.command_key === body.command_key
    && receipt.directory_step_ids.length === body.step_ids.length && new Set(body.step_ids).size === body.step_ids.length
    && body.step_ids.every((id) => receipt.directory_step_ids.includes(id));
  if (!("transition" in body) || action !== `directory_${body.transition}` || receipt.reason !== body.reason.trim()) return false;
  if (body.transition === "claim") return receipt.directory_step_ids.length > 0 && receipt.grant.command_key === body.command_key
    && receipt.grant.kind === "human" && receipt.principal.source === "human"
    && receipt.responsible_user_id === receipt.principal.actor_id && receipt.grant.responsible_user_id === receipt.responsible_user_id;
  if (receipt.directory_step_ids.length !== 0) return false;
  return body.transition === "pause" && receipt.state === "paused"
    || body.transition === "resume" && receipt.state === "active"
    || body.transition === "abandon" && receipt.state === "abandoned";
}

const existing = z.object({ code: z.literal("directory_operation_exists"), workspace_id: z.string().min(1),
  meeting_id: z.string().min(1), root_id: z.string().min(1), directory_operation_id: z.string().uuid(), command_key: z.string().uuid() });
export function cockpitExistingDirectoryOperation(error: unknown,
  expected: { workspaceId: string; meetingId: string; rootId: string; commandKey: string }): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const parsed = existing.safeParse(error.body);
  return parsed.success && parsed.data.workspace_id === expected.workspaceId && parsed.data.meeting_id === expected.meetingId
    && parsed.data.root_id === expected.rootId && parsed.data.command_key === expected.commandKey ? parsed.data.directory_operation_id : null;
}
