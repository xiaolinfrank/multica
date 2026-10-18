import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";

const meeting = z.object({ creation_key: z.string().uuid(), node_id: z.string().nullable(), meet_date: z.string(), start_time: z.string(), end_time: z.string(),
  kind: z.string(), status: z.string(), track: z.string(), parties: z.string(), organizer: z.string(), attendees: z.string(), location: z.string(), title: z.string() });
const provision = z.object({ create_task: z.boolean().optional(), create_dir: z.boolean().optional(), project_id: z.string().optional(), module_id: z.string().optional(),
  node_id: z.string().optional(), base_dir: z.string().optional(), folder_name: z.string().optional(), assignee_type: z.string().optional(), assignee_id: z.string().optional(), remember: z.boolean().optional() });
const workflow = z.object({ reviewer_id: z.string(), existing_issue_id: z.string().optional(), project_id: z.string().optional(), module_id: z.string().optional(),
  node_id: z.string().optional(), assignee_type: z.string().optional(), assignee_id: z.string().optional() });
const entry = z.object({ meeting, provision, workflow: workflow.nullable(), autoSaveEntries: z.array(z.object({ party: z.string(), name: z.string(), position: z.string() })),
  meetingId: z.string().nullable(), directoryOperationId: z.string().uuid().nullable().default(null), workflowCreated: z.boolean(), directoryReady: z.boolean(), uncertain: z.boolean() });
const schema = z.object({ byScope: z.record(z.string(), entry) });
export type CockpitMeetingCreationDraft = z.infer<typeof entry>;
export type CockpitMeetingCreationFields = z.infer<typeof meeting>;
/** User-confirmed commands and their acknowledged checkpoints; no meeting response or directory cache. */
export const useCockpitMeetingCreateDraftStore = createDraftStore<z.infer<typeof schema>>({
  storageKey: "multica_cockpit_meeting_creation_drafts", emptyData: { byScope: {} },
  hasMeaningful: (draft) => Object.keys(draft.byScope).length > 0,
  migrateData: (raw) => { const parsed = schema.safeParse(raw); return parsed.success ? parsed.data : { byScope: {} }; },
});
export function prepareCockpitMeetingCreation(key: string, input: Omit<CockpitMeetingCreationDraft, "meetingId" | "directoryOperationId" | "workflowCreated" | "directoryReady" | "uncertain">) {
  const state = useCockpitMeetingCreateDraftStore.getState(); const current = state.draft.byScope[key];
  if (current) {
    // Until creation is acknowledged, every part of the user's confirmed command stays fixed.
    if (!current.meetingId || current.meeting.creation_key !== input.meeting.creation_key) return current;
    const next = { ...current, provision: current.directoryReady || current.directoryOperationId ? current.provision : input.provision,
      workflow: current.workflowCreated ? current.workflow : input.workflow };
    state.setDraft({ byScope: { ...state.draft.byScope, [key]: next } }); return next;
  }
  const next: CockpitMeetingCreationDraft = { ...input, meetingId: null, directoryOperationId: null, workflowCreated: false, directoryReady: false, uncertain: false };
  state.setDraft({ byScope: { ...state.draft.byScope, [key]: next } }); return next;
}
function sameIntent(current: CockpitMeetingCreationDraft, observed: CockpitMeetingCreationDraft) {
  return JSON.stringify([current.meeting, current.provision, current.workflow, current.autoSaveEntries]) === JSON.stringify([observed.meeting, observed.provision, observed.workflow, observed.autoSaveEntries]);
}
export function checkpointCockpitMeetingCreation(key: string, observed: CockpitMeetingCreationDraft, patch: Partial<Pick<CockpitMeetingCreationDraft, "meetingId" | "directoryOperationId" | "workflowCreated" | "directoryReady">>) {
  const state = useCockpitMeetingCreateDraftStore.getState(); const current = state.draft.byScope[key];
  if (!current || !sameIntent(current, observed)) return;
  state.setDraft({ byScope: { ...state.draft.byScope, [key]: { ...current, ...patch } } });
}
export function settleCockpitMeetingCreation(key: string, observed: CockpitMeetingCreationDraft, outcome: "accepted" | "rejected" | "uncertain" | "discarded") {
  const state = useCockpitMeetingCreateDraftStore.getState(); const current = state.draft.byScope[key];
  if (!current || !sameIntent(current, observed)) return;
  const byScope = { ...state.draft.byScope };
  if (outcome === "accepted" || outcome === "discarded" || (outcome === "rejected" && !current.meetingId && !current.uncertain)) delete byScope[key];
  else if (!current.meetingId) byScope[key] = { ...current, uncertain: true };
  state.setDraft({ byScope });
}
