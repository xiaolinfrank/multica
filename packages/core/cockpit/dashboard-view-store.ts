import { create } from "zustand";
import { registerDraftCleanup } from "../drafts/cleanup-registry";

export interface CockpitDashboardView {
  audience: "mine" | "team";
  kind: string;
  mode: "overview" | "attention";
  pages: Record<string, { signature: string; cursors: string[] }>;
  scrollTop: number;
}

export const EMPTY_COCKPIT_DASHBOARD_VIEW: CockpitDashboardView = {
  audience: "mine", kind: "", mode: "overview", pages: {}, scrollTop: 0,
};

/** In-memory navigation context only; dashboard facts stay in Query and cursors are not persisted. */
export const useCockpitDashboardViewStore = create<{
  views: Record<string, CockpitDashboardView>;
  sessionGeneration: number;
  update: (viewKey: string, patch: Partial<Pick<CockpitDashboardView, "audience" | "kind" | "mode" | "scrollTop">>) => void;
  setPage: (viewKey: string, section: string, signature: string, cursors: string[]) => void;
  reset: () => void;
}>((set) => ({
  views: {},
  sessionGeneration: 0,
  update: (viewKey, patch) => set((state) => {
    const current = state.views[viewKey] ?? EMPTY_COCKPIT_DASHBOARD_VIEW;
    const attentionChanged = (["audience", "kind"] as const).some((field) => field in patch && patch[field] !== current[field]);
    const changed = attentionChanged;
    // Execution and meeting pages have no audience/type filter. Keep their
    // position when only the attention queue's scope changes.
    const pages = attentionChanged
      ? Object.fromEntries(Object.entries(current.pages).filter(([section]) => !section.startsWith("attention")))
      : current.pages;
    return { views: { ...state.views, [viewKey]: { ...current, ...patch, ...(changed ? { pages, scrollTop: 0 } : {}) } } };
  }),
  setPage: (viewKey, section, signature, cursors) => set((state) => {
    const current = state.views[viewKey] ?? EMPTY_COCKPIT_DASHBOARD_VIEW;
    return { views: { ...state.views, [viewKey]: { ...current, pages: { ...current.pages, [section]: { signature, cursors } } } } };
  }),
  reset: () => set((state) => ({ views: {}, sessionGeneration: state.sessionGeneration + 1 })),
}));

// No persisted payload; registration clears actor-bound cursors at session end.
registerDraftCleanup({ storageKey: "multica_cockpit_dashboard_context", workspaceScoped: false,
  resetInMemory: () => useCockpitDashboardViewStore.getState().reset() });
