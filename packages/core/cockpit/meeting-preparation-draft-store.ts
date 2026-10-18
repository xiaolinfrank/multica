import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";
import type { CockpitPreparationEffectDetail } from "../types/cockpit-meeting-preparation";

const id = z.string().uuid();
const revision = z.number().int().nonnegative();
const common = { command_key: id, expected_revision: revision };
const cancellationChoice = z.object({ issue_id: id, expected_revision: revision, action: z.enum(["retain", "cancel", "change_due_date", "link_meeting"]), cancel_status: z.string().nullable(),
  due_date: z.string().nullable(), target_meeting_id: id.nullable() });
const cancellationFields = { reason: z.string(), issues: z.array(cancellationChoice).max(50), run_ids: z.array(id).max(50) };

const dispositionTransition = z.enum(["reinstate", "archive", "unarchive"]);
const controlTransition = z.enum(["pause", "resume", "skip", "claim"]);
const formSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cancellation"), ...cancellationFields }),
  z.object({ kind: z.literal("disposition"), observedRevision: revision, transition: dispositionTransition, reason: z.string() }),
  z.object({ kind: z.literal("control"), observedRevision: revision, transition: controlTransition, effectId: id.nullable(), reason: z.string() }),
  z.object({ kind: z.literal("reauthorization"), observedRevision: revision, effectId: id, reason: z.string() }),
]);
const commandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cancellation"), meetingId: id, body: z.object({ ...common, ...cancellationFields, context_token: z.string().min(1) }) }),
  z.object({ kind: z.literal("append_disposition"), meetingId: id, body: z.object({ ...common, ...cancellationFields, context_token: z.string().min(1) }) }),
  z.object({ kind: z.literal("disposition"), meetingId: id, body: z.object({ ...common, transition: dispositionTransition, reason: z.string() }) }),
  z.object({ kind: z.literal("control"), meetingId: id, operationId: id, body: z.object({ ...common, transition: controlTransition, effect_id: id.nullable(), reason: z.string() }) }),
  z.object({ kind: z.literal("reauthorization"), meetingId: id, operationId: id, effectId: id, body: z.object({ ...common, context_token: z.string().min(1), reason: z.string() }) }),
  z.object({ kind: z.literal("effect"), meetingId: id, operationId: id, effectId: id, body: z.object({ command_key: id, authorization_key: id, authorization_revision: z.number().int().positive() }) }),
]);
const persisted = z.object({ forms: z.record(z.string(), formSchema), commands: z.record(z.string(), commandSchema), instances: z.record(z.string(), id) });
export type CockpitPreparationFormDraft = z.infer<typeof formSchema>;
export type CockpitPreparationPendingCommand = z.infer<typeof commandSchema>;
/** User-authored fields and exact unresolved commands only; server progress stays in Query. */
export const useCockpitMeetingPreparationDraftStore = createDraftStore<z.infer<typeof persisted>>({
  storageKey: "multica_cockpit_meeting_preparation_drafts", emptyData: { forms: {}, commands: {}, instances: {} },
  hasMeaningful: (data) => Object.keys(data.forms).length > 0 || Object.keys(data.commands).length > 0 || Object.keys(data.instances).length > 0,
  migrateData: (raw) => { const parsed = persisted.safeParse(raw); return parsed.success ? parsed.data : { forms: {}, commands: {}, instances: {} }; },
});

export const cockpitMeetingPreparationDraftKey = (wsId: string, kind: string, ...ids: string[]) => JSON.stringify([wsId, kind, ...ids]);

export function setCockpitPreparationForm(key: string, value: CockpitPreparationFormDraft) {
  const state = useCockpitMeetingPreparationDraftStore.getState();
  if (state.draft.commands[key]) return;
  state.setDraft({ forms: { ...state.draft.forms, [key]: formSchema.parse(value) } });
}

/** Only an acknowledgement of these exact fields may clear the captured draft. */
export function clearCockpitPreparationForm(key: string, observed: CockpitPreparationFormDraft) {
  const state = useCockpitMeetingPreparationDraftStore.getState();
  if (JSON.stringify(state.draft.forms[key]) !== JSON.stringify(observed)) return;
  const forms = { ...state.draft.forms }; delete forms[key]; state.setDraft({ forms });
}

function commandScope(value: CockpitPreparationPendingCommand) {
  return [value.kind, value.meetingId, "operationId" in value ? value.operationId : null, "effectId" in value ? value.effectId : null];
}

export function prepareCockpitPreparationCommand<T extends CockpitPreparationPendingCommand>(key: string, value: T): T {
  const state = useCockpitMeetingPreparationDraftStore.getState(); const previous = state.draft.commands[key];
  if (previous) {
    if (JSON.stringify(commandScope(previous)) !== JSON.stringify(commandScope(value))) throw new Error("meeting_preparation_command_scope_changed");
    return previous as T;
  }
  const parsed = commandSchema.parse(value) as T;
  state.setDraft({ commands: { ...state.draft.commands, [key]: parsed } }); return parsed;
}

/** Call only after a checked receipt or a definitive rejection, never on timeout or absence. */
export function settleCockpitPreparationCommand(key: string, observedCommandKey: string, observedAuthorization?: { authorization_key: string; authorization_revision: number }) {
  const state = useCockpitMeetingPreparationDraftStore.getState();
  const pending = state.draft.commands[key];
  if (pending?.body.command_key !== observedCommandKey) return;
  if (pending.kind === "effect" && (!observedAuthorization || pending.body.authorization_key !== observedAuthorization.authorization_key || pending.body.authorization_revision !== observedAuthorization.authorization_revision)) return;
  const commands = { ...state.draft.commands }; delete commands[key]; state.setDraft({ commands });
}

/** A stable navigation pointer is not an execution cursor or permission to resume. */
export function rememberCockpitPreparationInstance(key: string, instanceId: string) {
  const state = useCockpitMeetingPreparationDraftStore.getState();
  state.setDraft({ instances: { ...state.draft.instances, [key]: id.parse(instanceId) } });
}

/** A newer explicit grant makes the captured old grant unusable; equal revisions remain ambiguous. */
export function cockpitPreparationGrantReplaced(command: CockpitPreparationPendingCommand, detail: Pick<CockpitPreparationEffectDetail, "meeting_id" | "operation_id"> & {
  effect: Pick<CockpitPreparationEffectDetail["effect"], "operation_id" | "id" | "command_key" | "authorization_key" | "authorization_revision">;
}): boolean {
  return command.kind === "effect" && detail.meeting_id === command.meetingId && detail.operation_id === command.operationId
    && detail.effect.operation_id === command.operationId && detail.effect.id === command.effectId && detail.effect.command_key === command.body.command_key
    && id.safeParse(detail.effect.authorization_key).success && detail.effect.authorization_key !== command.body.authorization_key
    && detail.effect.authorization_revision > command.body.authorization_revision;
}
