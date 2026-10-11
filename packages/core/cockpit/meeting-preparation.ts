import { z } from "zod";
import { ApiError } from "../api/client";
import type { CockpitLifecycleCommandDetail } from "../types/cockpit-meeting-lifecycle";
import type {
  CockpitMeetingTemplateConfig, CockpitMeetingTemplateSaveInput, CockpitMeetingTemplateSaveResult,
  CockpitPreparationCommandResult, CockpitTemplateApplicationInput, CockpitCancellationInput,
  CockpitPreparationControlInput, CockpitPreparationEffectDetail, CockpitPreparationEffectResult,
  CockpitPreparationReauthorizationInput,
} from "../types/cockpit-meeting-preparation";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function normalizedConfig(config: CockpitMeetingTemplateConfig) {
  return { ...config, slots: config.slots.map((slot) => ({ ...slot, slot_id: slot.slot_id.toLowerCase(),
    agenda_slot_id: slot.agenda_slot_id?.toLowerCase() ?? null, label: slot.label.trim(), purpose: slot.purpose.trim(),
    agenda: slot.agenda ? { ...slot.agenda, title: slot.agenda.title.trim(), purposes: [...new Set(slot.agenda.purposes)].sort() } : null,
    new_issue: slot.new_issue ? { ...slot.new_issue, title: slot.new_issue.title.trim() } : null })) };
}
export function cockpitMeetingTemplateAcknowledged(result: CockpitMeetingTemplateSaveResult, body: CockpitMeetingTemplateSaveInput, templateId?: string | null): boolean {
  const receipt = result.receipt;
  return result.command_key === body.command_key && receipt.command_key === body.command_key
    && (!templateId || result.template_id === templateId) && receipt.template_id === result.template_id
    && receipt.title === body.title.trim() && receipt.description === body.description && receipt.active === body.active
    && JSON.stringify(canonical(normalizedConfig(receipt.config))) === JSON.stringify(canonical(normalizedConfig(body.config)));
}

/** A later GET reads the same fixed authorization receipt as the original POST. */
export function cockpitPreparationCommandAcknowledged(result: CockpitPreparationCommandResult | CockpitLifecycleCommandDetail, action: string,
  body: CockpitTemplateApplicationInput | CockpitCancellationInput | CockpitPreparationControlInput | CockpitPreparationReauthorizationInput, operationId?: string, effectId?: string): boolean {
  if (result.command_key !== body.command_key || result.action !== action) return false;
  const receipt = "operation_id" in result.receipt ? result.receipt : result.receipt.preparation;
  if (!receipt || operationId && receipt.operation_id !== operationId || !["apply_template", "cancel_preparation"].includes(receipt.kind)) return false;
  if ("context_token" in body && receipt.context_token !== body.context_token) return false;
  if (action === "template_apply") return "template_version_id" in body && receipt.kind === "apply_template"
    && receipt.template_version_id === body.template_version_id && receipt.effect_ids.length === body.bindings.filter((item) => item.selected).length;
  if (action === "cancel" || action === "preparation_dispose") return "issues" in body && receipt.kind === "cancel_preparation" && receipt.template_version_id === null
    && receipt.reason === body.reason.trim() && receipt.occurrence?.state === "cancelled" && Boolean(receipt.occurrence.cancelled_at)
    && (action !== "cancel" || receipt.occurrence.cancelled_reason === body.reason.trim())
    && receipt.effect_ids.length === body.issues.filter((item) => item.action !== "retain").length + new Set(body.run_ids).size;
  if (action === "preparation_reauthorize") return "context_token" in body && "reason" in body && Boolean(effectId)
    && receipt.effect_id === effectId && receipt.reason === body.reason.trim()
    && receipt.authorization?.key === body.command_key && receipt.authorization.context_token === body.context_token
    && Boolean(receipt.previous_authorization && receipt.authorization.revision === receipt.previous_authorization.revision + 1);
  if (!("transition" in body) || action !== `preparation_${body.transition}` || receipt.reason !== body.reason.trim()) return false;
  if (body.transition === "pause") return receipt.state === "paused";
  if (body.transition === "resume") return receipt.state === "active";
  if (body.transition === "skip") return Boolean(body.effect_id && receipt.effect_id === body.effect_id);
  return body.transition === "claim";
}

export function cockpitPreparationEffectAcknowledged(result: CockpitPreparationEffectDetail | CockpitPreparationEffectResult,
  operationId: string, effectId: string, commandKey: string, authorizationKey: string, authorizationRevision: number): boolean {
  if (result.operation_id !== operationId) return false;
  if ("effect" in result && (result.effect.id !== effectId || result.effect.command_key !== commandKey || result.effect.state !== "applied")) return false;
  if ("effect_id" in result && (result.effect_id !== effectId || result.command_key !== commandKey)) return false;
  const receipt = "effect" in result ? result.effect.receipt : result.receipt;
  return Boolean(receipt && receipt.effect_id === effectId && receipt.command_key === commandKey
    && receipt.authorization_key === authorizationKey && receipt.authorization_revision === authorizationRevision
    && ["agenda", "preparation_issue", "issue_reference", "material_reference", "cancel_issue", "change_due_date", "link_meeting", "stop_run"].includes(receipt.kind));
}

const existingOperation = z.object({ code: z.literal("application_exists"), workspace_id: z.string().min(1), meeting_id: z.string().min(1),
  template_version_id: z.string().min(1), operation_id: z.string().uuid(), command_key: z.string().uuid() });
export function cockpitExistingPreparationOperation(error: unknown, expected: { workspaceId: string; meetingId: string; templateVersionId: string; commandKey: string }): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const parsed = existingOperation.safeParse(error.body);
  return parsed.success && parsed.data.workspace_id === expected.workspaceId && parsed.data.meeting_id === expected.meetingId
    && parsed.data.template_version_id === expected.templateVersionId && parsed.data.command_key === expected.commandKey ? parsed.data.operation_id : null;
}
