import type { IssueTableGroupSpec, IssueTableQuerySpec } from "../../types";

/**
 * Whether the query is narrowed to at least one project.
 *
 * A project page narrows through `scope`; the projects filter chip narrows
 * through `filters.project_ids`. Either one bounds the set of modules the
 * query can name.
 */
export function issueTableQueryNamesProject(
  query: IssueTableQuerySpec,
): boolean {
  if (query.scope.kind === "project" && query.scope.project_id) return true;
  return (query.filters.project_ids?.length ?? 0) > 0;
}

/**
 * Group spec for module grouping.
 *
 * A module with no matching issue still owns a level of its project's
 * hierarchy, so it is asked for by name — but only while the query is narrowed
 * to a project. Modules belong to one project each, so outside a project the
 * catalog would be the whole workspace's and would bury the groups that hold
 * work.
 */
export function issueTableModuleGroupSpec(
  query: IssueTableQuerySpec,
): Extract<IssueTableGroupSpec, { kind: "module" }> {
  return issueTableQueryNamesProject(query)
    ? { kind: "module", include_empty: true }
    : { kind: "module" };
}
