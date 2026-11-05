"use client";

import {
  createCollectionViewStore,
  type CollectionSortDirection,
  type CollectionViewCore,
} from "../../collections/view-store";

// Projects is the one dual-view list: a dense table (compact) and a card
// grid (comfortable), toggled by viewMode. Sort + filters feed both views;
// hiddenColumns only applies to the table. No scope (lead is optional and
// often an agent, so there's no strong personal axis; status is a 5-value
// lifecycle better expressed as a filter). Search stays session-local.
export type ProjectViewMode = "compact" | "comfortable";

export type ProjectSortField = "name" | "priority" | "status" | "progress" | "created";

export type ProjectSortDirection = CollectionSortDirection;

export const PROJECT_SORT_DEFAULT_DIRECTION: Record<
  ProjectSortField,
  ProjectSortDirection
> = {
  name: "asc",
  priority: "desc",
  status: "asc",
  progress: "desc",
  created: "desc",
};

/** Multi-select filters. Empty array per dimension = inactive. */
export interface ProjectListFilters {
  /** ProjectStatus values. */
  statuses: string[];
  /** ProjectPriority values. */
  priorities: string[];
  /** Composite "type:id" lead refs (member or agent). */
  leads: string[];
}

export const EMPTY_PROJECT_FILTERS: ProjectListFilters = {
  statuses: [],
  priorities: [],
  leads: [],
};

// Hideable table columns. Name + status are the always-visible core (status
// is the project's defining lifecycle field), so they're not in this set.
export type ProjectColumnKey = "priority" | "progress" | "lead" | "issues" | "created";

/** Issues count is opt-in; the rest show by default (matching the prior
 *  compact table). */
export const PROJECT_DEFAULT_HIDDEN_COLUMNS: ProjectColumnKey[] = ["issues"];

export interface ProjectViewState
  extends CollectionViewCore<
    ProjectSortField,
    ProjectColumnKey,
    ProjectListFilters
  > {
  viewMode: ProjectViewMode;
  setViewMode: (mode: ProjectViewMode) => void;
}

// v1: default sortField changed from "created" to "status".
const PROJECTS_VIEW_STATE_VERSION = 1;

export const useProjectViewStore = createCollectionViewStore<
  ProjectSortField,
  ProjectColumnKey,
  ProjectListFilters,
  { viewMode: ProjectViewMode },
  { setViewMode: (mode: ProjectViewMode) => void }
>({
  name: "multica_projects_view",
  version: PROJECTS_VIEW_STATE_VERSION,
  // v0 payloads that never touched the sort control hold the old
  // "created"/"desc" default (or no sort fields at all). Flip only
  // those; "created" with a flipped direction was a deliberate pick,
  // and picking any field resets it to that field's default, so
  // {created, desc} is the only ambiguous pair left.
  migrate: (persisted, version) => {
    const p = (persisted ?? {}) as Partial<ProjectViewState>;
    if (version >= PROJECTS_VIEW_STATE_VERSION) return p;
    const untouchedDefault =
      p.sortField === undefined ||
      (p.sortField === "created" &&
        (p.sortDirection === undefined || p.sortDirection === "desc"));
    if (untouchedDefault) {
      return {
        ...p,
        sortField: "status",
        sortDirection: PROJECT_SORT_DEFAULT_DIRECTION.status,
      };
    }
    return p;
  },
  defaultSortField: "status",
  sortDefaultDirection: PROJECT_SORT_DEFAULT_DIRECTION,
  defaultHiddenColumns: PROJECT_DEFAULT_HIDDEN_COLUMNS,
  emptyFilters: EMPTY_PROJECT_FILTERS,
  extraState: { viewMode: "compact" },
  extraActions: (set) => ({ setViewMode: (mode) => set({ viewMode: mode }) }),
});
