import type { QueryClient } from "@tanstack/react-query";
import type { Issue } from "../types/issue";
import { cockpitKeys } from "./queries";
import { cockpitReadKeys } from "./read-queries";

// Issue filing-scope invalidation for realtime events (S4 review).
//
// Two producers move an issue's filing:
//   - a direct edit through the issue (UpdateIssue): the event carries the full
//     issue and change flags, with project_changed/module_changed set to FALSE
//     when only the work item moved;
//   - a plan edit that moves a work item: the event carries a bare row (id,
//     number, status, revision and the three scope ids) and only
//     work_item_changed.
// Both must refresh: the module aggregates (module:changed does), the plan
// surface, and every work-item issue page — the OLD work item's page too, which
// only a prefix-wide invalidation covers without reading the cache first.

export interface IssueFilingEvent {
  issue: Partial<Issue> & { id: string };
  /** The three server flags. A filing move sets work_item_changed (and the
   *  other two stay false); a title edit sets none. */
  workItemChanged?: boolean;
  moduleChanged?: boolean;
  projectChanged?: boolean;
}

/** Whether the event moved the issue's filing at all. A field edit that names
 *  none of the three dims must not invalidate every work item's pages. */
export function isFilingChange(event: IssueFilingEvent): boolean {
  return event.workItemChanged === true || event.moduleChanged === true || event.projectChanged === true;
}

/** Invalidate the caches a filing change touches. The event is carried for
 *  documentation and future per-id precision (reading the OLD work item
 *  requires the pre-write cache); today both producers refresh the same two
 *  prefixes. */
export function invalidateIssueFiling(qc: QueryClient, wsId: string, event: IssueFilingEvent): void {
  if (!event.issue.id || !isFilingChange(event)) return;
  // The whole tasks prefix: the new work item's page, the old one's, and the
  // module/project rows' pages all live under it (a node frame does the same).
  void qc.invalidateQueries({ queryKey: cockpitKeys.tasks(wsId) });
  // The plan surface holds per-work-item counts.
  void qc.invalidateQueries({ queryKey: cockpitReadKeys.all(wsId) });
}
