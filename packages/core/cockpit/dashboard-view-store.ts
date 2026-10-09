import { create } from "zustand";
import { registerDraftCleanup } from "../drafts/cleanup-registry";

export interface CockpitDashboardView {
  projectId: string;
  audience: "mine" | "team";
  kind: string;
  mode: "overview" | "attention";
  pages: Record<string, { signature: string; cursors: string[] }>;
  scrollTop: number;
}

export const EMPTY_COCKPIT_DASHBOARD_VIEW: CockpitDashboardView = {
  projectId: "", audience: "mine", kind: "", mode: "overview", pages: {}, scrollTop: 0,
};

/** In-memory navigation context only; dashboard facts stay in Query and cursors are not persisted. */
export const useCockpitDashboardViewStore = create<{
  views: Record<string, CockpitDashboardView>;
  sessionGeneration: number;
  update: (wsId: string, patch: Partial<Pick<CockpitDashboardView, "projectId" | "audience" | "kind" | "mode" | "scrollTop">>) => void;
  setPage: (wsId: string, section: string, signature: string, cursors: string[]) => void;
  reset: () => void;
}>((set) => ({
  views: {},
  sessionGeneration: 0,
  update: (wsId, patch) => set((state) => {
    const current = state.views[wsId] ?? EMPTY_COCKPIT_DASHBOARD_VIEW;
    const projectChanged = "projectId" in patch && patch.projectId !== current.projectId;
    const attentionChanged = (["audience", "kind"] as const).some((field) => field in patch && patch[field] !== current[field]);
    const changed = projectChanged || attentionChanged;
    // Execution and meeting pages have no audience/type filter. Keep their
    // position when only the attention queue's scope changes.
    const pages = projectChanged ? {} : attentionChanged
      ? Object.fromEntries(Object.entries(current.pages).filter(([section]) => !section.startsWith("attention")))
      : current.pages;
    return { views: { ...state.views, [wsId]: { ...current, ...patch, ...(changed ? { pages, scrollTop: 0 } : {}) } } };
  }),
  setPage: (wsId, section, signature, cursors) => set((state) => {
    const current = state.views[wsId] ?? EMPTY_COCKPIT_DASHBOARD_VIEW;
    return { views: { ...state.views, [wsId]: { ...current, pages: { ...current.pages, [section]: { signature, cursors } } } } };
  }),
  reset: () => set((state) => ({ views: {}, sessionGeneration: state.sessionGeneration + 1 })),
}));

// No persisted payload; registration clears actor-bound cursors at session end.
registerDraftCleanup({ storageKey: "multica_cockpit_dashboard_context", workspaceScoped: false,
  resetInMemory: () => useCockpitDashboardViewStore.getState().reset() });
