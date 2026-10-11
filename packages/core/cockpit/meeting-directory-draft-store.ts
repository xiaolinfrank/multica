import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";

const id = z.string().uuid();
const revision = z.number().int().nonnegative();
const mode = z.enum(["prepare", "repair"]);
const transition = z.enum(["pause", "resume", "claim", "abandon"]);
const ids = z.array(id).max(32).refine((value) => new Set(value).size === value.length);
const previewInput = {
  mode, root_id: id, relative_directory: z.string(), partitions: z.array(z.string()).max(16),
  observed_nas_dir: z.string(), observed_binding_revision: revision, bind_after_base: z.boolean(),
};
const command = { command_key: id, expected_revision: revision };
const forms = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prepare"), mode, rootId: z.string(), relativeDirectory: z.string(), partitions: z.array(z.string()).max(16),
    observedNasDir: z.string(), observedBindingRevision: revision, bindAfterBase: z.boolean() }),
  z.object({ kind: z.literal("retry"), observedRevision: revision, stepIds: ids, reason: z.string() }),
  z.object({ kind: z.literal("control"), observedRevision: revision, transition, reason: z.string() }),
]);
const commands = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prepare"), meetingId: id, body: z.object({ ...command, ...previewInput, context_token: z.string().min(1) }) }),
  z.object({ kind: z.literal("retry"), meetingId: id, operationId: id, body: z.object({ ...command, step_ids: ids.min(1), context_token: z.string().min(1), reason: z.string() }) }),
  z.object({ kind: z.literal("control"), meetingId: id, operationId: id, body: z.object({ ...command, transition, reason: z.string() }) }),
]);
const persisted = z.object({ forms: z.record(z.string(), forms), commands: z.record(z.string(), commands) });

export type CockpitDirectoryFormDraft = z.infer<typeof forms>;
export type CockpitDirectoryPrepareDraft = Extract<CockpitDirectoryFormDraft, { kind: "prepare" }>;
export type CockpitDirectoryPendingCommand = z.infer<typeof commands>;

/** Persist user input and unconfirmed commands only; directories and attempt results stay in Query. */
export const useCockpitMeetingDirectoryDraftStore = createDraftStore<z.infer<typeof persisted>>({
  storageKey: "multica_cockpit_meeting_directory_drafts",
  emptyData: { forms: {}, commands: {} },
  hasMeaningful: (data) => Object.keys(data.forms).length > 0 || Object.keys(data.commands).length > 0,
  migrateData: (raw) => { const parsed = persisted.safeParse(raw); return parsed.success ? parsed.data : { forms: {}, commands: {} }; },
});

export const cockpitMeetingDirectoryDraftKey = (workspaceId: string, meetingId: string, kind: string, ...ids: string[]) => JSON.stringify([workspaceId, meetingId, kind, ...ids]);

export function setCockpitDirectoryForm(key: string, value: CockpitDirectoryFormDraft) {
  const state = useCockpitMeetingDirectoryDraftStore.getState();
  if (state.draft.commands[key]) return;
  state.setDraft({ forms: { ...state.draft.forms, [key]: forms.parse(value) } });
}

export function clearCockpitDirectoryForm(key: string, observed: CockpitDirectoryFormDraft) {
  const state = useCockpitMeetingDirectoryDraftStore.getState();
  if (JSON.stringify(state.draft.forms[key]) !== JSON.stringify(observed)) return;
  const next = { ...state.draft.forms }; delete next[key]; state.setDraft({ forms: next });
}

function commandScope(value: CockpitDirectoryPendingCommand) {
  return [value.kind, value.meetingId, "operationId" in value ? value.operationId : null];
}

/** An unknown response freezes this command; new UI observations never replace its target or selected steps. */
export function prepareCockpitDirectoryCommand<T extends CockpitDirectoryPendingCommand>(key: string, value: T): T {
  const state = useCockpitMeetingDirectoryDraftStore.getState(); const previous = state.draft.commands[key];
  if (previous) {
    if (JSON.stringify(commandScope(previous)) !== JSON.stringify(commandScope(value))) throw new Error("directory_command_scope_changed");
    return previous as T;
  }
  const parsed = commands.parse(value) as T;
  state.setDraft({ commands: { ...state.draft.commands, [key]: parsed } }); return parsed;
}

/** Only a verified fixed receipt or a definitive command rejection can release the original key. */
export function settleCockpitDirectoryCommand(key: string, observedCommandKey: string) {
  const state = useCockpitMeetingDirectoryDraftStore.getState();
  if (state.draft.commands[key]?.body.command_key !== observedCommandKey) return;
  const next = { ...state.draft.commands }; delete next[key]; state.setDraft({ commands: next });
}
