import { create } from "zustand";
import { registerDraftCleanup } from "../drafts/cleanup-registry";
import type { CockpitScope } from "./navigation";
import type { CockpitMeetingOnlyFlag } from "./meeting-search";
import type { CockpitMeetingArchiveFilter } from "../types/cockpit-read";

export interface CockpitPlanContext {
  seeded: boolean;
  query: string;
  zoom: "month" | "week";
  collapsedIds: string[];
  rootIds: string[];
  showFinance: boolean;
  toolsOpen: boolean;
  includeArchivedMeetings: boolean;
  scrollTop: number;
  scrollLeft: number;
}
export const EMPTY_COCKPIT_PLAN_CONTEXT: CockpitPlanContext = {
  seeded: false, query: "", zoom: "month", collapsedIds: [], rootIds: [], showFinance: false, toolsOpen: true, includeArchivedMeetings: false, scrollTop: 0, scrollLeft: 0,
};
export interface CockpitMeetingContext {
  archive: CockpitMeetingArchiveFilter;
  view: "list" | "month" | "week" | "agenda" | "timeline";
  query: string;
  anchorDay: string | null;
  from: string;
  to: string;
  tracks: string[];
  kinds: string[];
  statuses: string[];
  parties: string[];
  only: CockpitMeetingOnlyFlag[];
  selectedDay: string | null;
  scrollTop: number;
  cursorKey: string;
  cursors: string[];
}
export const EMPTY_COCKPIT_MEETING_CONTEXT: CockpitMeetingContext = {
  archive: "active",
  view: "list", query: "", anchorDay: null, from: "", to: "", tracks: [], kinds: [], statuses: [], parties: [], only: [], selectedDay: null, scrollTop: 0, cursorKey: "", cursors: [""],
};
export const cockpitScopeViewKey = (wsId: string, scope: CockpitScope) => JSON.stringify([wsId, scope.projectId, scope.moduleId]);

export interface CockpitGovernanceContext { query: string; status: "pending" | "decided" | "all"; cursors: string[]; qualityOpen: boolean }
export const EMPTY_COCKPIT_GOVERNANCE_CONTEXT: CockpitGovernanceContext = { query: "", status: "pending", cursors: [""], qualityOpen: false };

export interface CockpitArtifactContext { query: string; status: string; relation: "owned" | "referenced" | "all"; cursorKey: string; cursors: string[]; scrollTop: number }
export const EMPTY_COCKPIT_ARTIFACT_CONTEXT: CockpitArtifactContext = { query: "", status: "", relation: "owned", cursorKey: "", cursors: [""], scrollTop: 0 };

export interface CockpitAgendaContext { query: string; includeRemoved: boolean; cursorKey: string; cursors: string[]; scrollTop: number }
export const EMPTY_COCKPIT_AGENDA_CONTEXT: CockpitAgendaContext = { query: "", includeRemoved: false, cursorKey: "", cursors: [""], scrollTop: 0 };

/** Session navigation state only. Scope belongs to the URL; read models and document bodies stay in Query. */
export const useCockpitScopeViewStore = create<{
  plans: Record<string, CockpitPlanContext>;
  meetings: Record<string, CockpitMeetingContext>;
  artifacts: Record<string, CockpitArtifactContext>;
  agendas: Record<string, CockpitAgendaContext>;
  governance: Record<string, CockpitGovernanceContext>;
  relations: Record<string, string[]>;
  sessionGeneration: number;
  updatePlan: (key: string, patch: Partial<CockpitPlanContext>) => void;
  updateMeeting: (key: string, patch: Partial<CockpitMeetingContext>) => void;
  updateGovernance: (key: string, patch: Partial<CockpitGovernanceContext>) => void;
  updateArtifact: (key: string, patch: Partial<CockpitArtifactContext>) => void;
  updateAgenda: (key: string, patch: Partial<CockpitAgendaContext>) => void;
  setRelationPage: (key: string, cursors: string[]) => void;
  reset: () => void;
}>((set) => ({
  plans: {}, meetings: {}, artifacts: {}, agendas: {}, governance: {}, relations: {}, sessionGeneration: 0,
  updatePlan: (key, patch) => set((state) => ({ plans: { ...state.plans, [key]: { ...(state.plans[key] ?? EMPTY_COCKPIT_PLAN_CONTEXT), ...patch } } })),
  updateMeeting: (key, patch) => set((state) => {
    const current = state.meetings[key] ?? EMPTY_COCKPIT_MEETING_CONTEXT;
    const changed = (["archive", "query", "view", "anchorDay", "from", "to", "tracks", "kinds", "statuses", "parties", "only", "selectedDay"] as const).some((field) => field in patch && JSON.stringify(current[field]) !== JSON.stringify(patch[field]));
    return { meetings: { ...state.meetings, [key]: { ...current, ...patch, ...(changed ? { cursors: [""], cursorKey: "", scrollTop: 0 } : {}) } } };
  }),
  updateGovernance: (key, patch) => set((state) => {
    const current = state.governance[key] ?? EMPTY_COCKPIT_GOVERNANCE_CONTEXT;
    const changed = (patch.query !== undefined && patch.query !== current.query) || (patch.status !== undefined && patch.status !== current.status);
    return { governance: { ...state.governance, [key]: { ...current, ...patch, ...(changed ? { cursors: [""] } : {}) } } };
  }),
  updateArtifact: (key, patch) => set((state) => {
    const current = state.artifacts[key] ?? EMPTY_COCKPIT_ARTIFACT_CONTEXT;
    const changed = (["query", "status", "relation"] as const).some((field) => field in patch && current[field] !== patch[field]);
    return { artifacts: { ...state.artifacts, [key]: { ...current, ...patch, ...(changed ? { cursors: [""], cursorKey: "", scrollTop: 0 } : {}) } } };
  }),
  setRelationPage: (key, cursors) => set((state) => ({ relations: { ...state.relations, [key]: cursors } })),
  updateAgenda: (key, patch) => set((state) => {
    const current = state.agendas[key] ?? EMPTY_COCKPIT_AGENDA_CONTEXT;
    const changed = (patch.query !== undefined && patch.query !== current.query)
      || (patch.includeRemoved !== undefined && patch.includeRemoved !== current.includeRemoved);
    return { agendas: { ...state.agendas, [key]: { ...current, ...patch, ...(changed ? { cursors: [""], cursorKey: "", scrollTop: 0 } : {}) } } };
  }),
  reset: () => set((state) => ({ plans: {}, meetings: {}, artifacts: {}, agendas: {}, governance: {}, relations: {}, sessionGeneration: state.sessionGeneration + 1 })),
}));
registerDraftCleanup({ storageKey: "multica_cockpit_scope_navigation", workspaceScoped: false,
  resetInMemory: () => useCockpitScopeViewStore.getState().reset() });

export const EMPTY_COCKPIT_RELATION_PAGE: string[] = [""];
export const cockpitRelationViewKey = (wsId: string, kind: string, objectId: string) => JSON.stringify([wsId, kind, objectId]);
