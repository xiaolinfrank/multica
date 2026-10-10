import { create } from "zustand";
import { registerDraftCleanup } from "../drafts/cleanup-registry";

export type CockpitHistorySection = "versions" | "handoffs" | "exports";
export interface CockpitHistoryView { section: CockpitHistorySection; exportStatus: string; cursors: Record<CockpitHistorySection, string[]> }
export const EMPTY_COCKPIT_HISTORY_VIEW: CockpitHistoryView = { section: "versions", exportStatus: "", cursors: { versions: [""], handoffs: [""], exports: [""] } };
export const cockpitHistoryViewKey = (wsId: string, meetingId: string) => JSON.stringify([wsId, meetingId]);

/** Only navigation context is retained. Documents and historical records remain in Query. */
export const useCockpitHistoryViewStore = create<{
  views: Record<string, CockpitHistoryView>;
  update: (key: string, patch: Partial<Pick<CockpitHistoryView, "section" | "exportStatus">>) => void;
  setPage: (key: string, section: CockpitHistorySection, cursors: string[]) => void;
  reset: () => void;
}>((set) => ({
  views: {},
  update: (key, patch) => set((state) => { const current = state.views[key] ?? EMPTY_COCKPIT_HISTORY_VIEW;
    const changed = patch.exportStatus !== undefined && patch.exportStatus !== current.exportStatus;
    return { views: { ...state.views, [key]: { ...current, ...patch, ...(changed ? { cursors: { ...current.cursors, exports: [""] } } : {}) } } }; }),
  setPage: (key, section, cursors) => set((state) => { const current = state.views[key] ?? EMPTY_COCKPIT_HISTORY_VIEW;
    return { views: { ...state.views, [key]: { ...current, cursors: { ...current.cursors, [section]: cursors } } } }; }),
  reset: () => set({ views: {} }),
}));
registerDraftCleanup({ storageKey: "multica_cockpit_minutes_history_view", workspaceScoped: false, resetInMemory: () => useCockpitHistoryViewStore.getState().reset() });
