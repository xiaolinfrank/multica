import { create } from "zustand";
import { registerDraftCleanup } from "../drafts/cleanup-registry";

export interface CockpitInputReferenceView {
  query: string;
  cursors: string[];
}
export const EMPTY_COCKPIT_INPUT_REFERENCE_VIEW: CockpitInputReferenceView = { query: "", cursors: [""] };
export const cockpitInputReferenceViewKey = (workspaceId: string, accountId: string, meetingId: string, agendaId: string | null = null) => JSON.stringify([workspaceId, accountId, meetingId, agendaId]);

/** Session-only return context; directory cursors and server data are not persisted. */
export const useCockpitInputViewStore = create<{
  references: Record<string, CockpitInputReferenceView>;
  updateReference: (key: string, patch: Partial<CockpitInputReferenceView>) => void;
  reset: () => void;
}>((set) => ({
  references: {},
  updateReference: (key, patch) => set((state) => {
    const current = state.references[key] ?? EMPTY_COCKPIT_INPUT_REFERENCE_VIEW;
    const changed = patch.query !== undefined && patch.query !== current.query;
    return { references: { ...state.references, [key]: { ...current, ...patch, ...(changed ? { cursors: [""] } : {}) } } };
  }),
  reset: () => set({ references: {} }),
}));
registerDraftCleanup({ storageKey: "multica_cockpit_input_navigation", workspaceScoped: false, resetInMemory: () => useCockpitInputViewStore.getState().reset() });
