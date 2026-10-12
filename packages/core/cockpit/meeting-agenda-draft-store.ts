import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";
import type { CockpitAgendaInput, CockpitAgendaReferenceInput, CockpitAgendaRemoveInput, CockpitLifecycleCommandInput, CockpitMaterialsInput, CockpitOccurrenceInput, CockpitPreparationIssueInput } from "../types/cockpit-meeting-lifecycle";

const purposes = z.enum(["planning", "goal_review", "boundary_confirmation", "question_clarification", "solution_discussion", "direction_decision"]);
const revision = z.number().int().nonnegative();
const common = { command_key: z.string().uuid(), expected_revision: revision };
const agendaFields = { title: z.string().optional(), purposes: z.array(purposes).optional(), desired_outcome: z.string().optional(), notes: z.string().optional(), facilitator_user_id: z.string().nullable().optional(), node_id: z.string().nullable().optional(), sort_order: z.number().optional() };
const agendaDraft = z.object({ observedRevision: revision, title: z.string(), purposes: z.array(purposes), desiredOutcome: z.string(), notes: z.string(), facilitatorId: z.string(), nodeId: z.string() });
const preparationFields = z.object({ title: z.string(), description: z.string(), assignee_type: z.enum(["member", "agent", "squad"]).nullable(), assignee_id: z.string().nullable(), priority: z.enum(["none", "urgent", "high", "medium", "low"]), due_date: z.string().nullable(), project_id: z.string().nullable(), module_id: z.string().nullable() });
const formSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("occurrence"), observedRevision: revision, transition: z.enum(["schedule", "start", "end", "correct_times", "reopen", "unstart", "unschedule"]), start: z.string(), end: z.string(), reason: z.string() }),
  z.object({ kind: z.literal("preparation"), observedRevision: revision, primaryNodeId: z.string().nullable(), fields: preparationFields }),
  z.object({ kind: z.literal("reference"), observedRevision: revision, referenceKind: z.enum(["issue", "artifact_reference"]), targetId: z.string(), purpose: z.enum(["preparation", "material"]) }),
  z.object({ kind: z.literal("remove"), observedRevision: revision, reason: z.string() }),
]);
export type CockpitMeetingFormDraft = z.infer<typeof formSchema>;
const commandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("occurrence"), body: z.object({ ...common, transition: z.enum(["schedule", "start", "end", "correct_times", "reopen", "unstart", "unschedule"]), actual_started_at: z.string().nullable().optional(), actual_ended_at: z.string().nullable().optional(), reason: z.string().optional() }) }),
  z.object({ kind: z.literal("materials"), body: z.object({ ...common, materials_ready: z.boolean() }) }),
  z.object({ kind: z.literal("agenda_create"), body: z.object({ ...common, ...agendaFields }) }),
  z.object({ kind: z.literal("agenda_update"), agendaId: z.string(), body: z.object({ ...common, ...agendaFields }) }),
  z.object({ kind: z.literal("agenda_remove"), agendaId: z.string(), body: z.object({ ...common, reason: z.string() }) }),
  z.object({ kind: z.literal("reference_attach"), agendaId: z.string(), body: z.object({ ...common, kind: z.enum(["issue", "artifact_reference"]), target_id: z.string(), purpose: z.enum(["preparation", "material"]) }) }),
  z.object({ kind: z.literal("reference_remove"), agendaId: z.string(), referenceId: z.string(), body: z.object(common) }),
  z.object({ kind: z.literal("preparation_issue_create"), agendaId: z.string(), body: z.object({ ...common, primary_node_id: z.string().nullable(), new_issue: z.object({ title: z.string(), description: z.string(), assignee_type: z.enum(["member", "agent", "squad"]).nullable(), assignee_id: z.string().nullable(), priority: z.enum(["none", "urgent", "high", "medium", "low"]), due_date: z.string().nullable(), project_id: z.string().nullable(), module_id: z.string().nullable() }) }) }),
]);
export type CockpitMeetingPendingCommand =
  | { kind: "occurrence"; body: CockpitOccurrenceInput }
  | { kind: "materials"; body: CockpitMaterialsInput }
  | { kind: "agenda_create"; body: CockpitAgendaInput }
  | { kind: "agenda_update"; agendaId: string; body: CockpitAgendaInput }
  | { kind: "agenda_remove"; agendaId: string; body: CockpitAgendaRemoveInput }
  | { kind: "reference_attach"; agendaId: string; body: CockpitAgendaReferenceInput }
  | { kind: "reference_remove"; agendaId: string; referenceId: string; body: CockpitLifecycleCommandInput }
  | { kind: "preparation_issue_create"; agendaId: string; body: CockpitPreparationIssueInput };
export type CockpitAgendaDraft = z.infer<typeof agendaDraft>;
const persisted = z.object({ agendas: z.record(z.string(), agendaDraft), commands: z.record(z.string(), commandSchema), forms: z.record(z.string(), formSchema).default({}) });
export const useCockpitMeetingAgendaDraftStore = createDraftStore<{ agendas: Record<string, CockpitAgendaDraft>; commands: Record<string, CockpitMeetingPendingCommand>; forms: Record<string, CockpitMeetingFormDraft> }>({
  storageKey: "multica_cockpit_meeting_agenda_drafts", emptyData: { agendas: {}, commands: {}, forms: {} },
  hasMeaningful: (draft) => Object.keys(draft.agendas).length > 0 || Object.keys(draft.commands).length > 0 || Object.keys(draft.forms).length > 0,
  migrateData: (raw) => { const parsed = persisted.safeParse(raw); return parsed.success ? parsed.data : { agendas: {}, commands: {}, forms: {} }; },
});
export const cockpitMeetingAgendaDraftKey = (wsId: string, meetingId: string, subject: string) => JSON.stringify([wsId, meetingId, subject]);

/** Preserve the original revision until the author explicitly reviews the latest source. */
export function updateCockpitAgendaDraft(key: string, initial: CockpitAgendaDraft, patch: Partial<Omit<CockpitAgendaDraft, "observedRevision">>) {
  const state = useCockpitMeetingAgendaDraftStore.getState();
  state.setDraft({ ...state.draft, agendas: { ...state.draft.agendas, [key]: { ...(state.draft.agendas[key] ?? initial), ...patch } } });
}
export function rebaseCockpitAgendaDraft(key: string, observedRevision: number) {
  const state = useCockpitMeetingAgendaDraftStore.getState(); const current = state.draft.agendas[key];
  if (current && !state.draft.commands[key]) state.setDraft({ ...state.draft, agendas: { ...state.draft.agendas, [key]: { ...current, observedRevision } } });
}
export function clearCockpitAgendaDraft(key: string, observed: CockpitAgendaDraft) {
  const state = useCockpitMeetingAgendaDraftStore.getState();
  if (JSON.stringify(state.draft.agendas[key]) !== JSON.stringify(observed)) return;
  const agendas = { ...state.draft.agendas }; delete agendas[key]; state.setDraft({ ...state.draft, agendas });
}
export function prepareCockpitMeetingCommand(key: string, command: CockpitMeetingPendingCommand): CockpitMeetingPendingCommand {
  const state = useCockpitMeetingAgendaDraftStore.getState(); const previous = state.draft.commands[key];
  if (previous) return previous;
  state.setDraft({ ...state.draft, commands: { ...state.draft.commands, [key]: command } }); return command;
}
export function settleCockpitMeetingCommand(key: string, commandKey: string) {
  const state = useCockpitMeetingAgendaDraftStore.getState();
  if (state.draft.commands[key]?.body.command_key !== commandKey) return;
  const commands = { ...state.draft.commands }; delete commands[key]; state.setDraft({ ...state.draft, commands });
}

export function setCockpitMeetingFormDraft(key: string, value: CockpitMeetingFormDraft) {
  const state = useCockpitMeetingAgendaDraftStore.getState();
  if (state.draft.commands[key]) return;
  state.setDraft({ ...state.draft, forms: { ...state.draft.forms, [key]: value } });
}
export function clearCockpitMeetingFormDraft(key: string, observed: CockpitMeetingFormDraft) {
  const state = useCockpitMeetingAgendaDraftStore.getState();
  if (JSON.stringify(state.draft.forms[key]) !== JSON.stringify(observed)) return;
  const forms = { ...state.draft.forms }; delete forms[key]; state.setDraft({ ...state.draft, forms });
}
