import type { Issue, UpdateIssueRequest } from "@multica/core/types";

/** The issue fields the gate reads. */
export type ModuleGateIssue = Pick<
  Issue,
  "id" | "title" | "parent_issue_id" | "project_id" | "module_id"
>;

/** Payload for the `issue-module-detach-confirm` modal, or null when the write
 *  needs no confirmation. Carries the write itself so the dialog applies
 *  exactly what the user asked for, plus the detach it has to add. */
export type ModuleDetachIntent = {
  issueId: string;
  issueTitle: string;
  /** The filing the issue is moving to, as the caller expressed it. */
  updates: Partial<UpdateIssueRequest>;
};

/**
 * Whether re-filing this issue would break its link to its parent.
 *
 * A sub-issue sits in its parent's module — that is what lets a module group
 * show the whole of the work filed under it, and what makes moving a parent
 * carry its children. So an issue with a parent cannot be re-filed on its own:
 * the server refuses it (`child_module_mismatch`), and the one way through is
 * to detach in the same write. This gate spots that case BEFORE the request,
 * so every entry point — the module picker, the table's module column, a drag
 * onto another module group, a board or swimlane drop — asks first instead of
 * toasting a refusal.
 *
 * Because the invariant holds on stored data, "differs from the issue's own
 * module" is the same test as "differs from the parent's module", and no
 * parent lookup is needed. A project move counts too: it re-files the issue,
 * and the module goes with the project.
 */
export function moduleDetachIntent(
  issue: ModuleGateIssue,
  updates: Partial<UpdateIssueRequest>,
): ModuleDetachIntent | null {
  if (!issue.parent_issue_id) return null;
  const movesModule =
    updates.module_id !== undefined &&
    (updates.module_id ?? null) !== (issue.module_id ?? null);
  const movesProject =
    updates.project_id !== undefined &&
    (updates.project_id ?? null) !== (issue.project_id ?? null);
  if (!movesModule && !movesProject) return null;
  return { issueId: issue.id, issueTitle: issue.title, updates };
}
