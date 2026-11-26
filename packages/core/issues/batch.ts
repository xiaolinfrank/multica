import type {
  Issue,
  IssueStatus,
  IssuePriority,
  IssueAssigneeType,
} from "../types";

/**
 * Shared assignee across a selection. `{ type: null, id: null }` means every
 * selected issue is unassigned — a real shared value, distinct from a mixed
 * selection (which {@link commonIssueFields} reports as `assignee: null`).
 */
export interface CommonAssignee {
  type: IssueAssigneeType | null;
  id: string | null;
}

/**
 * Shared ownership across a selection (`project_id` / `module_id` /
 * `work_item_id`). All-null means every selected issue has no ownership — a real
 * shared value, distinct from a mixed selection (`scope: null`).
 */
export interface CommonIssueScope {
  project_id: string | null;
  module_id: string | null;
  work_item_id: string | null;
}

/**
 * The status / priority / assignee / ownership shared by every issue in a batch
 * selection. A field is `null` when the selection is empty or the issues
 * disagree ("mixed"). Batch property pickers use this to reflect the real
 * common value and fall back to an empty (no-checkmark) state when the values
 * differ, instead of asserting a hardcoded default.
 */
export interface CommonIssueFields {
  status: IssueStatus | null;
  priority: IssuePriority | null;
  assignee: CommonAssignee | null;
  scope: CommonIssueScope | null;
}

export type BatchScopeIssue = Pick<
  Issue,
  | "id"
  | "identifier"
  | "title"
  | "parent_issue_id"
  | "project_id"
  | "module_id"
  | "work_item_id"
>;

export interface BatchScopeParentConflict {
  issue: BatchScopeIssue;
  parentId: string;
  parent: BatchScopeIssue | null;
}

/**
 * Returns the value shared by every item, or `null` when the list is empty or
 * the items disagree. Comparison is by primitive equality, so callers pass a
 * scalar key (collapse composite values to a string before calling).
 */
function sharedValue<T>(values: readonly T[]): T | null {
  if (values.length === 0) return null;
  const first = values[0]!;
  return values.every((v) => v === first) ? first : null;
}

const KEY_SEP = "\u0000";

/**
 * Collapse a polymorphic assignee (type + id, either nullable) into a single
 * comparable key so all-unassigned issues compare equal to each other and
 * distinct from any assigned actor.
 */
function assigneeKey(type: IssueAssigneeType | null, id: string | null): string {
  return `${type ?? ""}${KEY_SEP}${id ?? ""}`;
}

function scopeKey(
  projectId: string | null | undefined,
  moduleId: string | null | undefined,
  workItemId: string | null | undefined,
): string {
  return `${projectId ?? ""}${KEY_SEP}${moduleId ?? ""}${KEY_SEP}${workItemId ?? ""}`;
}

export function sameIssueScope(
  a: { project_id?: string | null; module_id?: string | null; work_item_id?: string | null },
  b: { project_id?: string | null; module_id?: string | null; work_item_id?: string | null },
): boolean {
  return (
    (a.project_id ?? null) === (b.project_id ?? null) &&
    (a.module_id ?? null) === (b.module_id ?? null) &&
    (a.work_item_id ?? null) === (b.work_item_id ?? null)
  );
}

/**
 * Derive the common status / priority / assignee / ownership of the selected
 * issues. Pass the already-filtered selection (the issues that are actually
 * selected), mirroring how the skill list filters rows by `selectedIds` before
 * handing them to its batch toolbar.
 */
export function commonIssueFields(issues: readonly Issue[]): CommonIssueFields {
  const status = sharedValue(issues.map((i) => i.status));
  const priority = sharedValue(issues.map((i) => i.priority));

  const sharedAssigneeKey = sharedValue(
    issues.map((i) => assigneeKey(i.assignee_type, i.assignee_id)),
  );
  const assignee =
    sharedAssigneeKey !== null && issues.length > 0
      ? { type: issues[0]!.assignee_type, id: issues[0]!.assignee_id }
      : null;

  const sharedScopeKey = sharedValue(
    issues.map((i) => scopeKey(i.project_id, i.module_id, i.work_item_id)),
  );
  const scope =
    sharedScopeKey !== null && issues.length > 0
      ? {
          project_id: issues[0]!.project_id ?? null,
          module_id: issues[0]!.module_id ?? null,
          work_item_id: issues[0]!.work_item_id ?? null,
        }
      : null;

  return { status, priority, assignee, scope };
}

/**
 * Identify selected sub-issues whose ownership change would leave them in a
 * different project, module, or work item than their parent.
 *
 * Moving a parent automatically moves its subtree on the server, so selecting a
 * parent (with or without its children) keeps parent and children aligned. A
 * conflict occurs when a sub-issue moves to `target`, none of its ancestors in
 * the loaded hierarchy are included in the same batch, and its parent is not
 * already in `target`.
 */
export function findBatchScopeParentConflicts(
  selectedIssues: readonly BatchScopeIssue[],
  target: CommonIssueScope,
  allKnownIssues: readonly BatchScopeIssue[] = selectedIssues,
): BatchScopeParentConflict[] {
  const selectedIds = new Set(selectedIssues.map((issue) => issue.id));
  const byId = new Map<string, BatchScopeIssue>();
  for (const issue of allKnownIssues) byId.set(issue.id, issue);
  for (const issue of selectedIssues) byId.set(issue.id, issue);

  const conflicts: BatchScopeParentConflict[] = [];
  for (const issue of selectedIssues) {
    if (!issue.parent_issue_id) continue;
    if (sameIssueScope(issue, target)) continue;

    const visited = new Set<string>([issue.id]);
    let cur: string | null = issue.parent_issue_id;
    let coveredBySelectedAncestor = false;
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      if (selectedIds.has(cur)) {
        coveredBySelectedAncestor = true;
        break;
      }
      cur = byId.get(cur)?.parent_issue_id ?? null;
    }
    if (coveredBySelectedAncestor) continue;

    const parent = byId.get(issue.parent_issue_id) ?? null;
    if (parent && sameIssueScope(parent, target)) continue;

    conflicts.push({
      issue,
      parentId: issue.parent_issue_id,
      parent,
    });
  }
  return conflicts;
}
