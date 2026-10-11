import { z } from "zod";
import { cockpitInputDraftKey, type CockpitInputFormDraft, type CockpitInputPendingCommand } from "./input-draft-store";

const id = z.string().uuid();
const agendaId = z.union([id, z.literal("")]);
const meetingKey = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upload"), targets: z.tuple([id, agendaId]) }),
  z.object({ kind: z.literal("nas"), targets: z.tuple([id, agendaId]) }),
  z.object({ kind: z.literal("source-input"), targets: z.tuple([id, agendaId]) }),
  z.object({ kind: z.literal("reference"), targets: z.tuple([id, agendaId, id]) }),
  z.object({ kind: z.literal("remove-reference"), targets: z.tuple([id, id]) }),
]);
const keyEnvelope = z.tuple([id, id, z.string()]).rest(z.string());

export interface CockpitMeetingInputDraftEntry {
  key: string;
  kind: "upload" | "nas" | "source-input" | "reference" | "remove-reference";
  meetingId: string;
  agendaId: string | null;
  targetId: string | null;
  hasPendingCommand: boolean;
  unfinishedItems: number;
  inputId: string | null;
  versionId: string | null;
}

type InputDrafts = { forms: Record<string, CockpitInputFormDraft>; commands: Record<string, CockpitInputPendingCommand> };

/** Only exact, known client keys identify a return destination. Unknown keys
 * remain untouched and are never assigned to a workspace by string matching. */
export function cockpitMeetingInputDraftEntries(drafts: InputDrafts, workspaceId: string, accountId: string, meetingId: string): CockpitMeetingInputDraftEntry[] {
  const entries: CockpitMeetingInputDraftEntry[] = [];
  for (const key of new Set([...Object.keys(drafts.forms), ...Object.keys(drafts.commands)])) {
    let raw: unknown;
    try { raw = JSON.parse(key); } catch { continue; }
    const envelope = keyEnvelope.safeParse(raw);
    if (!envelope.success || envelope.data[0] !== workspaceId || envelope.data[1] !== accountId) continue;
    const target = meetingKey.safeParse({ kind: envelope.data[2], targets: envelope.data.slice(3) });
    if (!target.success || target.data.targets[0] !== meetingId) continue;
    const { kind, targets } = target.data;
    const form = drafts.forms[key]; const command = drafts.commands[key];
    const agenda = kind === "remove-reference" ? null : targets[1] || null;
    if (form && (kind !== "remove-reference" && form.agendaId !== agenda)) continue;
    if (command) {
      if (kind === "reference" && (command.kind !== "reference" || command.meetingId !== meetingId || command.body.agendaId !== agenda || command.body.inputVersionId !== targets[2])) continue;
      if (kind === "remove-reference" && (command.kind !== "remove_reference" || command.meetingId !== meetingId || command.referenceId !== targets[1])) continue;
      if ((kind === "upload" || kind === "source-input") && !["create", "version", "restart", "finalize", "abandon"].includes(command.kind)) continue;
      if (command.kind === "version" && (!command.body.initialReference || command.body.initialReference.meetingId !== meetingId || command.body.initialReference.agendaId !== agenda)) continue;
    }
    if (!command && !form) continue;
    if (!command && form && !form.inputId && !form.declaration && !form.source && form.sourceSelections.length === 0 && form.selectedVersionIds.length === 0) continue;
    let unfinishedItems = command ? 1 : 0;
    if (kind === "nas" && form?.batch) {
      if (form.batch.meetingId !== meetingId || form.batch.childKeys.length !== form.batch.selectionIds.length) continue;
      let valid = true;
      unfinishedItems = 0;
      for (const [index, childKey] of form.batch.childKeys.entries()) {
        const child = drafts.forms[childKey];
        const selectionId = form.batch.selectionIds[index];
        if (!selectionId || childKey !== cockpitInputDraftKey(workspaceId, accountId, "nas-selection", meetingId, selectionId)
          || !child?.batchItem || child.batchItem.parentKey !== key || child.batchItem.selectionId !== selectionId || child.generation !== selectionId || child.agendaId !== form.agendaId) { valid = false; break; }
        const pending = drafts.commands[childKey];
        if (pending && (pending.kind !== "create" && pending.kind !== "version" || pending.kind === "version" && (pending.inputId !== child.inputId
          || !pending.body.initialReference || pending.body.initialReference.meetingId !== meetingId || pending.body.initialReference.agendaId !== form.agendaId))) { valid = false; break; }
        if (drafts.commands[childKey] || !child.versionId && !child.batchItem.skipped || child.batchItem.skipped && child.inputId) unfinishedItems += 1;
      }
      if (!valid) continue;
    }
    entries.push({ key, kind, meetingId, agendaId: agenda, targetId: kind === "reference" ? targets[2] : kind === "remove-reference" ? targets[1] : null,
      hasPendingCommand: Boolean(command), unfinishedItems, inputId: form?.inputId ?? null, versionId: form?.versionId ?? null });
  }
  return entries;
}
