import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";
import type { CockpitMaterialsInput, CockpitOccurrenceInput } from "../types/cockpit-meeting-lifecycle";

const revision = z.number().int().nonnegative();
const common = { command_key: z.string().uuid(), expected_revision: revision };
const formSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("occurrence"), observedRevision: revision, transition: z.enum(["schedule", "end", "correct_times", "reopen", "unschedule"]), start: z.string(), end: z.string(), reason: z.string() }),
  z.object({ kind: z.literal("remove"), observedRevision: revision, reason: z.string() }),
]);
export type CockpitMeetingFormDraft = z.infer<typeof formSchema>;
const commandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("occurrence"), body: z.object({ ...common, transition: z.enum(["schedule", "end", "correct_times", "reopen", "unschedule"]), actual_started_at: z.string().nullable().optional(), actual_ended_at: z.string().nullable().optional(), reason: z.string().optional() }) }),
  z.object({ kind: z.literal("materials"), body: z.object({ ...common, materials_ready: z.boolean() }) }),
]);
export type CockpitMeetingPendingCommand =
  | { kind: "occurrence"; body: CockpitOccurrenceInput }
  | { kind: "materials"; body: CockpitMaterialsInput };
const persisted = z.object({ commands: z.record(z.string(), commandSchema), forms: z.record(z.string(), formSchema).default({}) });
export const useCockpitMeetingAgendaDraftStore = createDraftStore<{ commands: Record<string, CockpitMeetingPendingCommand>; forms: Record<string, CockpitMeetingFormDraft> }>({
  storageKey: "multica_cockpit_meeting_agenda_drafts", emptyData: { commands: {}, forms: {} },
  hasMeaningful: (draft) => Object.keys(draft.commands).length > 0 || Object.keys(draft.forms).length > 0,
  migrateData: (raw) => { const parsed = persisted.safeParse(raw); return parsed.success ? parsed.data : { commands: {}, forms: {} }; },
});
export const cockpitMeetingAgendaDraftKey = (wsId: string, meetingId: string, subject: string) => JSON.stringify([wsId, meetingId, subject]);

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
