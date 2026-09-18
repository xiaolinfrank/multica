import type { IssueScope } from "@multica/core/issues/surface/scope";
import type { CreateIssueRequest } from "@multica/core/types";
import type {
  TableGrouping,
  ViewMode,
} from "@multica/core/issues/stores/view-store";

export type IssueCreateDefaults = Partial<
  Omit<
    CreateIssueRequest,
    "assignee_type" | "assignee_id" | "parent_issue_id" | "project_id"
  >
> & {
  assignee_type?: CreateIssueRequest["assignee_type"] | null;
  assignee_id?: string | null;
  parent_issue_id?: string | null;
  /** Display-only context for the create dialog while the parent query loads. */
  parent_issue_identifier?: string;
  project_id?: string | null;
};

export type IssueSurfaceMode = Extract<
  ViewMode,
  "board" | "list" | "table" | "swimlane" | "gantt"
>;

export interface IssueSurfaceProps {
  scope: IssueScope;
  modes: IssueSurfaceMode[];
  surfaceKey?: string;
  createDefaults?: IssueCreateDefaults;
  /** Server-owned membership search shared by non-Table issue surfaces. */
  search?: string;
  /** Page-level module narrowing (the project detail module strip). Travels
   *  server-side with the Table query and client-side everywhere else, like
   *  the project scope. Deliberately not part of the persisted filter set:
   *  the strip owns selecting and clearing it. */
  moduleFilter?: IssueSurfaceModuleFilter;
  /** Table grouping applied while the user has not picked one explicitly
   *  (e.g. "module" on a project page that has modules). Ignored once the
   *  store's grouping is touched, and while a saved view is open. */
  defaultTableGrouping?: TableGrouping;
}

export interface IssueSurfaceModuleFilter {
  module_ids?: string[];
  include_no_module?: boolean;
}
