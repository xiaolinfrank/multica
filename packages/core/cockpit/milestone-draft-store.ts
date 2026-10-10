import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";
const entry = z.object({ name: z.string(), date: z.string(), nodeId: z.string(), uncertain: z.boolean() });
const schema = z.object({ byScope: z.record(z.string(), entry) });
export type CockpitMilestoneDraft = z.infer<typeof entry>;
export const useCockpitMilestoneDraftStore = createDraftStore<z.infer<typeof schema>>({ storageKey: "multica_cockpit_milestone_drafts", emptyData: { byScope: {} },
  hasMeaningful: (draft) => Object.values(draft.byScope).some((item) => Boolean(item.name || item.date || item.nodeId || item.uncertain)),
  migrateData: (raw) => { const result = schema.safeParse(raw); return result.success ? result.data : { byScope: {} }; } });
export function setCockpitMilestoneDraft(key: string, value: CockpitMilestoneDraft) {
  const state = useCockpitMilestoneDraftStore.getState(); state.setDraft({ byScope: { ...state.draft.byScope, [key]: value } });
}
export function settleCockpitMilestoneDraft(key: string, observed: CockpitMilestoneDraft, outcome: "accepted" | "uncertain" | "discarded") {
  const state = useCockpitMilestoneDraftStore.getState(); if (JSON.stringify(state.draft.byScope[key]) !== JSON.stringify(observed)) return;
  const byScope = { ...state.draft.byScope }; if (outcome !== "uncertain") delete byScope[key]; else byScope[key] = { ...observed, uncertain: true }; state.setDraft({ byScope });
}
