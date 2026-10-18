import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";
import * as schemas from "../api/cockpit-input-schemas";
import { cockpitInputBody } from "../api/cockpit-input-transport";

const id = z.string().uuid();
const revision = z.number().int().nonnegative();
const text = z.string().max(16000);
const source = z.preprocess(cockpitInputBody, schemas.CockpitInputSourceInputSchema);
const ids = z.array(id).max(200).refine((values) => new Set(values).size === values.length);
const item = z.preprocess(cockpitInputBody, schemas.CockpitInputManifestItemInputSchema);
const form = z.object({
  generation: id,
  title: z.string().max(512), description: text,
  purpose: z.enum(["material", "recording", "supporting"]), agendaId: id.nullable(),
  declaration: z.object({ filename: z.string().max(255), contentType: z.string().max(255), sizeBytes: revision, lastModified: revision }).nullable(),
  source: source.nullable(), selectedVersionIds: ids, manifestItems: z.array(item).max(200), note: text,
  sourceSelections: z.array(z.object({ selectionId: id, rootId: id, relativePath: z.string().min(1), observationToken: z.string().min(1),
    filename: z.string().min(1), sizeBytes: revision.nullable(), modifiedAt: z.string().nullable() })).max(50)
    .refine((values) => new Set(values.map((value) => value.selectionId)).size === values.length
      && new Set(values.map((value) => JSON.stringify([value.rootId, value.relativePath]))).size === values.length).default([]),
  nasBrowse: z.object({ rootId: id, scopePath: z.string(), relativeDirectory: z.string(), q: z.string() }).nullable().default(null),
  batch: z.object({ meetingId: id, selectionIds: z.array(id).min(1).max(50), childKeys: z.array(z.string()).min(1).max(50) })
    .refine((value) => value.selectionIds.length === value.childKeys.length && new Set(value.childKeys).size === value.childKeys.length).nullable().default(null),
  batchItem: z.object({ parentKey: z.string(), selectionId: id, skipped: z.boolean(), skipReason: text }).nullable().default(null),
  registrationEnd: z.object({ originalKey: z.string(), reason: text.refine((value) => Boolean(value.trim())), endedAt: z.string().datetime() }).nullable().default(null),
  observedRevision: revision.nullable(),
  inputId: id.nullable(), inputRevision: revision.nullable(), versionId: id.nullable(), transferId: id.nullable(), transferRevision: revision.nullable(),
});
const commands = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), body: z.preprocess(cockpitInputBody, schemas.CockpitInputCreateInputSchema) }),
  z.object({ kind: z.literal("version"), inputId: id, body: z.preprocess(cockpitInputBody, schemas.CockpitInputVersionSubmitInputSchema) }),
  z.object({ kind: z.literal("restart"), inputId: id, versionId: id, body: z.preprocess(cockpitInputBody, schemas.CockpitInputRestartInputSchema) }),
  z.object({ kind: z.literal("finalize"), inputId: id, versionId: id, transferId: id, body: z.preprocess(cockpitInputBody, schemas.CockpitInputFinalizeInputSchema) }),
  z.object({ kind: z.literal("abandon"), inputId: id, versionId: id, transferId: id, body: z.preprocess(cockpitInputBody, schemas.CockpitInputAbandonInputSchema) }),
  z.object({ kind: z.literal("manifest"), issueId: id, body: z.preprocess(cockpitInputBody, schemas.CockpitInputManifestSaveInputSchema) }),
]);
const persisted = z.object({ forms: z.record(z.string(), form), commands: z.record(z.string(), commands) });
export type CockpitInputFormDraft = z.infer<typeof form>;
export type CockpitInputPendingCommand = z.infer<typeof commands>;

/** Only user selections, observations, exact commands, and acknowledged pointers
 * survive reloads. File objects, bytes, server projections, and progress do not. */
export const useCockpitInputDraftStore = createDraftStore<z.infer<typeof persisted>>({
  storageKey: "multica_cockpit_input_drafts", emptyData: { forms: {}, commands: {} },
  hasMeaningful: (data) => Object.values(data.forms).some((value) => !value.registrationEnd) || Object.keys(data.commands).length > 0,
  migrateData: (raw) => { const result = persisted.safeParse(raw); return result.success ? result.data : { forms: {}, commands: {} }; },
});

export function cockpitInputDraftKey(workspaceId: string, accountId: string, kind: string, ...targetIds: string[]): string {
  return JSON.stringify([workspaceId, accountId, kind, ...targetIds]);
}
export function emptyCockpitInputForm(generation: string, agendaId: string | null = null): CockpitInputFormDraft {
  return { generation, title: "", description: "", purpose: "material", agendaId, declaration: null, source: null,
    selectedVersionIds: [], manifestItems: [], note: "", observedRevision: null,
    sourceSelections: [], nasBrowse: null, batch: null, batchItem: null, registrationEnd: null,
    inputId: null, inputRevision: null, versionId: null, transferId: null, transferRevision: null };
}
export function setCockpitInputForm(key: string, value: CockpitInputFormDraft): void {
  const state = useCockpitInputDraftStore.getState();
  if (state.draft.commands[key] || state.draft.forms[key]?.batch || state.draft.forms[key]?.registrationEnd) return;
  state.setDraft({ forms: { ...state.draft.forms, [key]: form.parse(value) } });
}
export function advanceCockpitInputForm(key: string, generation: string, patch: Partial<CockpitInputFormDraft>): void {
  const state = useCockpitInputDraftStore.getState();
  const current = state.draft.forms[key];
  if (!current || current.generation !== generation || state.draft.commands[key] || current.registrationEnd) return;
  state.setDraft({ forms: { ...state.draft.forms, [key]: form.parse({ ...current, ...patch, generation }) } });
}
export function clearCockpitInputForm(key: string, observed: CockpitInputFormDraft): void {
  const state = useCockpitInputDraftStore.getState();
  if (state.draft.commands[key] || state.draft.forms[key]?.batch || state.draft.forms[key]?.registrationEnd || JSON.stringify(state.draft.forms[key]) !== JSON.stringify(observed)) return;
  const forms = { ...state.draft.forms }; delete forms[key]; state.setDraft({ forms });
}
export function prepareCockpitInputCommand<T extends CockpitInputPendingCommand>(key: string, value: T): T {
  const state = useCockpitInputDraftStore.getState();
  const previous = state.draft.commands[key];
  if (previous) {
    const scope = (command: CockpitInputPendingCommand) => JSON.stringify({ ...command, body: undefined });
    if (scope(previous) !== scope(value)) throw new Error("input_command_scope_changed");
    return previous as T;
  }
  if (state.draft.forms[key]?.registrationEnd) throw new Error("input_registration_ended");
  const parsed = commands.parse(value) as T;
  state.setDraft({ commands: { ...state.draft.commands, [key]: parsed } });
  return parsed;
}
/** Call only after a matching immutable receipt or an explicit definitive rejection. */
export function settleCockpitInputCommand(key: string, commandKey: string): void {
  const state = useCockpitInputDraftStore.getState();
  if (state.draft.commands[key]?.body.commandKey !== commandKey) return;
  const commands = { ...state.draft.commands }; delete commands[key]; state.setDraft({ commands });
}

/** Capture the whole selected batch in one client-state write before its first
 * server command. Every child owns separate idempotency keys and recovery. */
export function beginCockpitInputNASBatch(workspaceId: string, accountId: string, meetingId: string, parentKey: string, observed: CockpitInputFormDraft) {
  const state = useCockpitInputDraftStore.getState();
  const parent = state.draft.forms[parentKey];
  if (!parent || parent.generation !== observed.generation || JSON.stringify(parent) !== JSON.stringify(observed) || state.draft.commands[parentKey]) {
    throw new Error("input_batch_context_changed");
  }
  const scope: unknown = JSON.parse(parentKey);
  if (!Array.isArray(scope) || scope[0] !== workspaceId || scope[1] !== accountId) throw new Error("input_batch_context_changed");
  if (parent.batch) return parent.batch;
  if (parent.sourceSelections.length < 1) throw new Error("input_batch_selection_required");
  const forms = { ...state.draft.forms };
  const childKeys: string[] = [];
  for (const selection of parent.sourceSelections) {
    const childKey = cockpitInputDraftKey(workspaceId, accountId, "nas-selection", meetingId, selection.selectionId);
    if (forms[childKey] || state.draft.commands[childKey]) throw new Error("input_batch_selection_in_use");
    childKeys.push(childKey);
    forms[childKey] = form.parse({ ...emptyCockpitInputForm(selection.selectionId, parent.agendaId),
      title: selection.filename, description: parent.description, purpose: parent.purpose,
      source: { kind: "nas_file", nasFile: { rootId: selection.rootId, relativePath: selection.relativePath, observationToken: selection.observationToken } },
      batchItem: { parentKey, selectionId: selection.selectionId, skipped: false, skipReason: "" },
    });
  }
  const batch = { meetingId, selectionIds: parent.sourceSelections.map((selection) => selection.selectionId), childKeys };
  forms[parentKey] = form.parse({ ...parent, batch });
  state.setDraft({ forms });
  return batch;
}

/** Skipping preserves any registered input/version pointers and an explanation;
 * an unconfirmed command must be reconciled before another user decision. */
export function skipCockpitInputNASItem(key: string, generation: string, reason: string): void {
  const state = useCockpitInputDraftStore.getState(); const current = state.draft.forms[key];
  if (!current?.batchItem || current.generation !== generation || state.draft.commands[key] || current.registrationEnd) throw new Error("input_batch_context_changed");
  const explanation = reason.trim();
  if (!explanation) throw new Error("input_skip_reason_required");
  state.setDraft({ forms: { ...state.draft.forms, [key]: form.parse({ ...current,
    batchItem: { ...current.batchItem, skipped: true, skipReason: explanation },
  }) } });
}

export function resumeCockpitInputNASItem(key: string, generation: string): void {
  const state = useCockpitInputDraftStore.getState(); const current = state.draft.forms[key];
  if (!current?.batchItem || current.generation !== generation || state.draft.commands[key] || current.registrationEnd) throw new Error("input_batch_context_changed");
  state.setDraft({ forms: { ...state.draft.forms, [key]: form.parse({ ...current,
    batchItem: { ...current.batchItem, skipped: false, skipReason: "" },
  }) } });
}

/** Completed registrations are recoverable through their server references.
 * Explicitly ended registrations retain their original local entry and input
 * pointer; they are never counted as a confirmed fixed version. */
export function completeCockpitInputNASBatch(parentKey: string, generation: string, nextGeneration: string): void {
  const state = useCockpitInputDraftStore.getState(); const parent = state.draft.forms[parentKey];
  if (!parent?.batch || parent.generation !== generation || state.draft.commands[parentKey]) throw new Error("input_batch_context_changed");
  const forms = { ...state.draft.forms };
  for (const [index, childKey] of parent.batch.childKeys.entries()) {
    const child = forms[childKey];
    if (!child || child.batchItem?.parentKey !== parentKey || child.batchItem.selectionId !== parent.batch.selectionIds[index]
      || state.draft.commands[childKey] || !child.versionId && !(child.batchItem.skipped && !child.inputId)
        && !(child.registrationEnd && child.inputId)) throw new Error("input_batch_unfinished");
    if (!child.registrationEnd) delete forms[childKey];
  }
  forms[parentKey] = form.parse({ ...emptyCockpitInputForm(nextGeneration, parent.agendaId), purpose: parent.purpose, nasBrowse: parent.nasBrowse });
  state.setDraft({ forms });
}


/** Resolve only recognized registration keys. Unknown client records must
 * never be assigned a guessed scope or deleted as collateral cleanup. */
export function cockpitInputRegistrationScope(workspaceId: string, accountId: string, meetingId: string, originalKey: string, value: CockpitInputFormDraft): "nas" | "single" | null {
  if (value.batchItem) {
    const item = value.batchItem;
    return value.generation === item.selectionId
      && originalKey === cockpitInputDraftKey(workspaceId, accountId, "nas-selection", meetingId, item.selectionId)
      && item.parentKey === cockpitInputDraftKey(workspaceId, accountId, "nas", meetingId, value.agendaId || "") ? "nas" : null;
  }
  return ["upload", "source-input"].some((kind) => originalKey === cockpitInputDraftKey(workspaceId, accountId, kind, meetingId, value.agendaId || "")) ? "single" : null;
}

/** End this device's remaining intent, preserving the acknowledged header.
 * Moving a single form and freeing its original slot is one atomic state write. */
export function endCockpitInputRegistration(workspaceId: string, accountId: string, meetingId: string, key: string, generation: string, reason: string): void {
  const state = useCockpitInputDraftStore.getState(); const current = state.draft.forms[key];
  if (!current || current.registrationEnd || current.generation !== generation || state.draft.commands[key]
    || !current.inputId || current.inputRevision === null || current.versionId || current.transferId || current.batch) throw new Error("input_registration_context_changed");
  const scope = cockpitInputRegistrationScope(workspaceId, accountId, meetingId, key, current);
  if (!scope) throw new Error("input_registration_context_changed");
  if (scope === "nas") {
    const parent = state.draft.forms[current.batchItem!.parentKey];
    if (parent?.batch?.meetingId !== meetingId || !parent.batch.childKeys.includes(key)) throw new Error("input_registration_context_changed");
  }
  const explanation = reason.trim(); if (!explanation) throw new Error("input_end_reason_required");
  const recordKey = scope === "nas" ? key : cockpitInputDraftKey(workspaceId, accountId, "ended-registration", meetingId, generation);
  if (recordKey !== key && (state.draft.forms[recordKey] || state.draft.commands[recordKey])) throw new Error("input_registration_context_changed");
  const forms = { ...state.draft.forms, [recordKey]: form.parse({ ...current,
    registrationEnd: { originalKey: key, reason: explanation, endedAt: new Date().toISOString() },
    ...(current.batchItem ? { batchItem: { ...current.batchItem, skipped: false, skipReason: "" } } : {}),
  }) };
  if (recordKey !== key) delete forms[key];
  state.setDraft({ forms });
}

/** Removal affects only a recognized ended record. An active NAS batch still
 * owns its child pointer until the user explicitly finishes that batch. */
export function removeEndedCockpitInputRegistration(workspaceId: string, accountId: string, meetingId: string, key: string, generation: string): void {
  const state = useCockpitInputDraftStore.getState(); const current = state.draft.forms[key];
  if (!current?.registrationEnd || current.generation !== generation || state.draft.commands[key]
    || !current.inputId || current.versionId || current.transferId) throw new Error("input_registration_context_changed");
  const scope = cockpitInputRegistrationScope(workspaceId, accountId, meetingId, current.registrationEnd.originalKey, current);
  if (!scope || scope === "single" && key !== cockpitInputDraftKey(workspaceId, accountId, "ended-registration", meetingId, generation)
    || scope === "nas" && (key !== current.registrationEnd.originalKey || state.draft.forms[current.batchItem!.parentKey]?.batch?.childKeys.includes(key))) throw new Error("input_registration_context_changed");
  const forms = { ...state.draft.forms }; delete forms[key]; state.setDraft({ forms });
}
