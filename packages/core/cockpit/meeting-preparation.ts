import type { CockpitLifecycleCommandDetail } from "../types/cockpit-meeting-lifecycle";
import type {
  CockpitPreparationCommandResult, CockpitCancellationInput,
  CockpitPreparationControlInput, CockpitPreparationEffectDetail, CockpitPreparationEffectResult,
  CockpitPreparationReauthorizationInput,
} from "../types/cockpit-meeting-preparation";


/** A later GET reads the same fixed authorization receipt as the original POST. */
export function cockpitPreparationCommandAcknowledged(result: CockpitPreparationCommandResult | CockpitLifecycleCommandDetail, action: string,
  body: CockpitCancellationInput | CockpitPreparationControlInput | CockpitPreparationReauthorizationInput, operationId?: string, effectId?: string): boolean {
  if (result.command_key !== body.command_key || result.action !== action) return false;
  const receipt = "operation_id" in result.receipt ? result.receipt : result.receipt.preparation;
  if (!receipt || operationId && receipt.operation_id !== operationId || receipt.kind !== "cancel_preparation") return false;
  if ("context_token" in body && receipt.context_token !== body.context_token) return false;
  if (action === "cancel" || action === "preparation_dispose") return "issues" in body && receipt.kind === "cancel_preparation"
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
    && ["cancel_issue", "change_due_date", "link_meeting", "stop_run"].includes(receipt.kind));
}
