import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";
import { cockpitInputRegistrationScope, cockpitInputDraftKey, type CockpitInputFormDraft, type CockpitInputPendingCommand } from "./input-draft-store";

const id = z.string().uuid();
const keyEnvelope = z.tuple([id, id, z.string()]).rest(z.string());


type InputDrafts = { forms: Record<string, CockpitInputFormDraft>; commands: Record<string, CockpitInputPendingCommand> };


const launchIntent = z.object({
  attemptId: id, manifestVersionId: id, startedAt: z.string().datetime(),
  state: z.enum(["pending", "unknown", "confirmed", "rejected"]), confirmedRunId: id.nullable(),
}).refine((value) => value.state === "confirmed" ? value.confirmedRunId !== null : value.confirmedRunId === null);
export type CockpitInputRunLaunchIntent = z.infer<typeof launchIntent>;
const launchData = z.object({ intents: z.record(z.string(), launchIntent) });
const launchKey = z.tuple([id, id, z.literal("input-run-launch"), id]);
export const cockpitInputRunLaunchKey = (workspaceId: string, accountId: string, issueId: string) => JSON.stringify([workspaceId, accountId, "input-run-launch", issueId]);

/** Non-idempotent launches retain user authorization across refreshes. Similar
 * runs in history are never proof that this launch was accepted. */
export const useCockpitInputRunLaunchStore = createDraftStore<z.infer<typeof launchData>>({
  storageKey: "multica_cockpit_input_run_launches", emptyData: { intents: {} },
  hasMeaningful: (data) => Object.values(data.intents).some((item) => item.state === "pending" || item.state === "unknown"),
  migrateData: (raw) => { const result = launchData.safeParse(raw); return result.success ? result.data : { intents: {} }; },
});
export function beginCockpitInputRunLaunch(key: string, intent: Pick<CockpitInputRunLaunchIntent, "attemptId" | "manifestVersionId" | "startedAt">, observed: CockpitInputRunLaunchIntent | null = null, authorizeAdditional = false): boolean {
  let parsed: unknown; try { parsed = JSON.parse(key); } catch { return false; }
  if (!launchKey.safeParse(parsed).success) return false;
  const state = useCockpitInputRunLaunchStore.getState(); const current = state.draft.intents[key];
  if (JSON.stringify(current ?? null) !== JSON.stringify(observed)) return false;
  if (current && ["pending", "unknown"].includes(current.state) && !authorizeAdditional) return false;
  const value = launchIntent.parse({ ...intent, state: "pending", confirmedRunId: null });
  state.setDraft({ intents: { ...state.draft.intents, [key]: value } }); return true;
}
export function settleCockpitInputRunLaunch(key: string, attemptId: string, outcome: { state: "confirmed"; runId: string } | { state: "unknown" | "rejected" }): void {
  const state = useCockpitInputRunLaunchStore.getState(); const current = state.draft.intents[key];
  if (!current || current.attemptId !== attemptId || current.state !== "pending") return;
  state.setDraft({ intents: { ...state.draft.intents, [key]: launchIntent.parse({ ...current, state: outcome.state, confirmedRunId: outcome.state === "confirmed" ? outcome.runId : null }) } });
}

export function cockpitInputVersionDraftEntries(drafts: InputDrafts, workspaceId: string, accountId: string, inputId: string): Array<{ key: string; kind: "input-version" | "recover-input-version"; versionId: string | null; hasPendingCommand: boolean }> {
  const entries: Array<{ key: string; kind: "input-version" | "recover-input-version"; versionId: string | null; hasPendingCommand: boolean }> = [];
  for (const key of new Set([...Object.keys(drafts.forms), ...Object.keys(drafts.commands)])) {
    let raw: unknown; try { raw = JSON.parse(key); } catch { continue; }
    const envelope = keyEnvelope.safeParse(raw);
    if (!envelope.success || envelope.data[0] !== workspaceId || envelope.data[1] !== accountId || envelope.data[3] !== inputId) continue;
    const parts = envelope.data; const kind = parts[2];
    if (kind !== "input-version" && kind !== "recover-input-version") continue;
    if (kind === "input-version" ? parts.length !== 4 : parts.length !== 5 || !id.safeParse(parts[4]).success) continue;
    const form = drafts.forms[key]; const command = drafts.commands[key]; const versionId = kind === "recover-input-version" ? parts[4]! : form?.versionId ?? null;
    if (form && (form.inputId !== inputId || kind === "recover-input-version" && form.versionId !== versionId)) continue;
    if (command && (!("inputId" in command) || command.inputId !== inputId || !(command.kind === "version" || command.kind === "restart" || command.kind === "finalize" || command.kind === "abandon")
      || "versionId" in command && command.versionId !== versionId)) continue;
    if (!command && (!form || !form.declaration && !form.versionId)) continue;
    entries.push({ key, kind, versionId, hasPendingCommand: Boolean(command) });
  }
  return entries;
}


export interface CockpitEndedInputRegistration {
  key: string; generation: string; inputId: string; title: string; description: string;
  agendaId: string | null; sourcePath: string; reason: string; endedAt: string; inActiveBatch: boolean;
}
/** These are this device's user-authored registration records, not shared
 * server audit events. Unrecognized keys and unconfirmed commands stay intact. */
export function cockpitEndedInputRegistrations(drafts: InputDrafts, workspaceId: string, accountId: string, meetingId: string, agendaId?: string): CockpitEndedInputRegistration[] {
  const result: CockpitEndedInputRegistration[] = [];
  for (const [key, value] of Object.entries(drafts.forms)) {
    const ended = value.registrationEnd;
    if (!ended || !value.inputId || value.versionId || value.transferId || drafts.commands[key] || agendaId && value.agendaId !== agendaId) continue;
    const scope = cockpitInputRegistrationScope(workspaceId, accountId, meetingId, ended.originalKey, value);
    if (!scope || scope === "single" && key !== cockpitInputDraftKey(workspaceId, accountId, "ended-registration", meetingId, value.generation)
      || scope === "nas" && key !== ended.originalKey) continue;
    const parent = value.batchItem ? drafts.forms[value.batchItem.parentKey] : undefined;
    result.push({ key, generation: value.generation, inputId: value.inputId, title: value.title, description: value.description,
      agendaId: value.agendaId, sourcePath: value.source?.nasFile?.relativePath || value.source?.upload?.filename || "", reason: ended.reason, endedAt: ended.endedAt,
      inActiveBatch: Boolean(parent?.batch?.childKeys.includes(key)),
    });
  }
  return result.sort((a, b) => b.endedAt.localeCompare(a.endedAt) || a.key.localeCompare(b.key));
}
