import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";
const entry = z.object({ nodeId: z.string(), field: z.string(), value: z.string(), reason: z.string() });
const schema = z.object({ byScope: z.record(z.string(), entry) });
export type CockpitChangeDraft = z.infer<typeof entry>;
export const EMPTY_COCKPIT_CHANGE_DRAFT: CockpitChangeDraft = { nodeId: "", field: "status", value: "", reason: "" };
export const useCockpitChangeDraftStore = createDraftStore<z.infer<typeof schema>>({ storageKey: "multica_cockpit_change_drafts", emptyData: { byScope: {} }, hasMeaningful: (draft) => Object.values(draft.byScope).some((item) => Boolean(item.nodeId || item.value || item.reason)), migrateData: (raw) => { const value = schema.safeParse(raw); return value.success ? value.data : { byScope: {} }; } });
export function setCockpitChangeDraft(key: string, value: CockpitChangeDraft) { const state = useCockpitChangeDraftStore.getState(); state.setDraft({ byScope: { ...state.draft.byScope, [key]: value } }); }
export function acknowledgeCockpitChangeDraft(key: string, observed: CockpitChangeDraft) {
  const state = useCockpitChangeDraftStore.getState(); if (JSON.stringify(state.draft.byScope[key]) !== JSON.stringify(observed)) return;
  state.setDraft({ byScope: { ...state.draft.byScope, [key]: { ...observed, value: "", reason: "" } } });
}
