import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";
import type { CockpitPreparationEffectDetail } from "../types/cockpit-meeting-preparation";

const id = z.string().uuid();
const revision = z.number().int().nonnegative();
const common = { command_key: id, expected_revision: revision };
const priority = z.enum(["none", "urgent", "high", "medium", "low"]);
const agendaDefaults = z.object({ title: z.string(), purposes: z.array(z.enum(["planning", "goal_review", "boundary_confirmation", "question_clarification", "solution_discussion", "direction_decision"])), desired_outcome: z.string(), notes: z.string() });
const issueDefaults = z.object({ title: z.string(), description: z.string(), priority });
const slot = z.object({
  slot_id: id, kind: z.enum(["agenda", "preparation_issue", "issue_reference", "material_reference"]), label: z.string(),
  agenda_slot_id: id.nullable(), agenda: agendaDefaults.nullable(), new_issue: issueDefaults.nullable(), purpose: z.string(),
}).refine((value) => value.kind === "agenda" ? value.agenda !== null && value.new_issue === null && value.agenda_slot_id === null && value.purpose === ""
  : value.agenda === null && value.agenda_slot_id !== null && (value.kind === "preparation_issue" ? value.new_issue !== null && value.purpose === ""
    : value.new_issue === null && (value.kind === "material_reference" ? value.purpose === "material" : value.purpose === "preparation" || value.purpose === "material")));
const config = z.object({ schema_version: z.literal(1), slots: z.array(slot).max(50) });
const templateFields = { title: z.string(), description: z.string(), active: z.boolean(), config };
const binding = z.object({
  slot_id: id, selected: z.boolean(), node_id: id.nullable(), facilitator_user_id: id.nullable(),
  project_id: id.nullable(), module_id: id.nullable(), assignee_type: z.enum(["member", "agent", "squad"]).nullable(), assignee_id: id.nullable(),
  due_date: z.string().nullable(), issue_id: id.nullable(), material_reference_id: id.nullable(),
});
const applicationFields = { template_version_id: id, bindings: z.array(binding).max(50) };
const cancellationChoice = z.object({ issue_id: id, expected_revision: revision, action: z.enum(["retain", "cancel", "change_due_date", "link_meeting"]), cancel_status: z.string().nullable(),
  due_date: z.string().nullable(), target_meeting_id: id.nullable(), target_agenda_id: id.nullable() });
const cancellationFields = { reason: z.string(), issues: z.array(cancellationChoice).max(50), run_ids: z.array(id).max(50) };

const dispositionTransition = z.enum(["reinstate", "archive", "unarchive"]);
const controlTransition = z.enum(["pause", "resume", "skip", "claim"]);
const templateForm = z.object({ kind: z.literal("template"), observedRevision: revision, ...templateFields });
const formSchema = z.discriminatedUnion("kind", [
  templateForm,
  z.object({ kind: z.literal("application"), templateId: id, ...applicationFields }),
  z.object({ kind: z.literal("cancellation"), ...cancellationFields }),
  z.object({ kind: z.literal("disposition"), observedRevision: revision, transition: dispositionTransition, reason: z.string() }),
  z.object({ kind: z.literal("control"), observedRevision: revision, transition: controlTransition, effectId: id.nullable(), reason: z.string() }),
  z.object({ kind: z.literal("reauthorization"), observedRevision: revision, effectId: id, reason: z.string() }),
]);
const commandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("template"), templateId: id.nullable(), body: z.object({ ...common, ...templateFields }) }),
  z.object({ kind: z.literal("application"), meetingId: id, body: z.object({ ...common, ...applicationFields, context_token: z.string().min(1) }) }),
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
export type CockpitTemplateEditorDraft = Extract<CockpitPreparationFormDraft, { kind: "template" }>;
export type CockpitTemplateApplicationDraft = Extract<CockpitPreparationFormDraft, { kind: "application" }>;

/** Newer template schema or kinds remain readable through metadata, but cannot become an editable draft. */
export function parseCockpitTemplateEditorDraft(value: unknown): CockpitTemplateEditorDraft | null {
  const result = templateForm.safeParse(value); return result.success ? result.data : null;
}

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
  if (value.kind === "template") return [value.kind, value.templateId];
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
