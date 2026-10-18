import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";

export interface CockpitMeetingNotesDraft { note: string; baseNote: string }
const schema = z.object({ byMeeting: z.record(z.string(), z.object({ note: z.string(), baseNote: z.string() })) });
export const useCockpitMeetingMaterialsDraftStore = createDraftStore<{ byMeeting: Record<string, CockpitMeetingNotesDraft> }>({
  storageKey: "multica_cockpit_meeting_materials_drafts", emptyData: { byMeeting: {} },
  hasMeaningful: (draft) => Object.values(draft.byMeeting).some((entry) => entry.note !== entry.baseNote),
  migrateData: (raw) => { const parsed = schema.safeParse(raw); return parsed.success ? parsed.data : { byMeeting: {} }; },
});

export function cockpitMeetingNotesDraftKey(wsId: string, meetingId: string): string {
  return JSON.stringify([wsId, meetingId]);
}

export function setCockpitMeetingNotesDraft(draftKey: string, note: string, baseNote: string) {
  const store = useCockpitMeetingMaterialsDraftStore.getState();
  const previous = store.draft.byMeeting[draftKey];
  store.setDraft({ byMeeting: { ...store.draft.byMeeting, [draftKey]: { note, baseNote: previous?.baseNote ?? baseNote } } });
}

export function rebaseCockpitMeetingNotesDraft(draftKey: string, baseNote: string) {
  const store = useCockpitMeetingMaterialsDraftStore.getState();
  const previous = store.draft.byMeeting[draftKey];
  if (previous) store.setDraft({ byMeeting: { ...store.draft.byMeeting, [draftKey]: { ...previous, baseNote } } });
}

/** A saved/read-back note clears only the exact user draft that it confirms. */
export function acknowledgeCockpitMeetingNotesDraft(draftKey: string, note: string) {
  const store = useCockpitMeetingMaterialsDraftStore.getState();
  if (store.draft.byMeeting[draftKey]?.note !== note) return;
  const byMeeting = { ...store.draft.byMeeting }; delete byMeeting[draftKey]; store.setDraft({ byMeeting });
}
