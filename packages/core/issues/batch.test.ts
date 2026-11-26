import { describe, it, expect } from "vitest";
import type { Issue } from "../types";
import {
  commonIssueFields,
  findBatchScopeParentConflicts,
  sameIssueScope,
} from "./batch";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    workspace_id: "ws-1",
    number: 1,
    identifier: "MUL-1",
    title: "Issue 1",
    description: null,
    status: "todo",
    priority: "none",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "user-1",
    parent_issue_id: null,
    project_id: null,
    position: 1,
    stage: null,
    start_date: null,
    due_date: null,
    metadata: {},
  properties: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("commonIssueFields", () => {
  it("returns all-null for an empty selection (nothing to reflect)", () => {
    expect(commonIssueFields([])).toEqual({
      status: null,
      priority: null,
      assignee: null,
      scope: null,
    });
  });

  it("reflects a single issue's own fields", () => {
    const common = commonIssueFields([
      makeIssue({ status: "in_progress", priority: "high", assignee_type: "member", assignee_id: "u-1" }),
    ]);
    expect(common.status).toBe("in_progress");
    expect(common.priority).toBe("high");
    expect(common.assignee).toEqual({ type: "member", id: "u-1" });
  });

  it("returns the shared status when every issue agrees, not a hardcoded default", () => {
    // Regression for MUL-3510: the batch picker used to assert "todo"
    // regardless of the selection.
    const common = commonIssueFields([
      makeIssue({ id: "a", status: "in_review" }),
      makeIssue({ id: "b", status: "in_review" }),
    ]);
    expect(common.status).toBe("in_review");
  });

  it("returns null status when the selection spans different statuses (mixed)", () => {
    const common = commonIssueFields([
      makeIssue({ id: "a", status: "todo" }),
      makeIssue({ id: "b", status: "done" }),
    ]);
    expect(common.status).toBeNull();
  });

  it("derives each field independently — shared status, mixed priority", () => {
    const common = commonIssueFields([
      makeIssue({ id: "a", status: "blocked", priority: "urgent" }),
      makeIssue({ id: "b", status: "blocked", priority: "low" }),
    ]);
    expect(common.status).toBe("blocked");
    expect(common.priority).toBeNull();
  });

  it("treats an all-unassigned selection as a real shared value, not mixed", () => {
    const common = commonIssueFields([
      makeIssue({ id: "a", assignee_type: null, assignee_id: null }),
      makeIssue({ id: "b", assignee_type: null, assignee_id: null }),
    ]);
    expect(common.assignee).toEqual({ type: null, id: null });
  });

  it("returns the shared assignee when every issue points at the same actor", () => {
    const common = commonIssueFields([
      makeIssue({ id: "a", assignee_type: "agent", assignee_id: "agent-1" }),
      makeIssue({ id: "b", assignee_type: "agent", assignee_id: "agent-1" }),
    ]);
    expect(common.assignee).toEqual({ type: "agent", id: "agent-1" });
  });

  it("returns null assignee when actors differ", () => {
    const common = commonIssueFields([
      makeIssue({ id: "a", assignee_type: "member", assignee_id: "u-1" }),
      makeIssue({ id: "b", assignee_type: "member", assignee_id: "u-2" }),
    ]);
    expect(common.assignee).toBeNull();
  });

  it("returns null assignee when some are assigned and some are unassigned", () => {
    const common = commonIssueFields([
      makeIssue({ id: "a", assignee_type: "member", assignee_id: "u-1" }),
      makeIssue({ id: "b", assignee_type: null, assignee_id: null }),
    ]);
    expect(common.assignee).toBeNull();
  });

  it("distinguishes assignees of the same id but different type", () => {
    const common = commonIssueFields([
      makeIssue({ id: "a", assignee_type: "member", assignee_id: "x" }),
      makeIssue({ id: "b", assignee_type: "agent", assignee_id: "x" }),
    ]);
    expect(common.assignee).toBeNull();
  });

  it("derives shared ownership across project, module, and work item", () => {
    const common = commonIssueFields([
      makeIssue({ id: "a", project_id: "p-1", module_id: "m-1", work_item_id: "wi-1" }),
      makeIssue({ id: "b", project_id: "p-1", module_id: "m-1", work_item_id: "wi-1" }),
    ]);
    expect(common.scope).toEqual({
      project_id: "p-1",
      module_id: "m-1",
      work_item_id: "wi-1",
    });
  });

  it("treats all-unfiled issues as a real shared ownership, not mixed", () => {
    const common = commonIssueFields([
      makeIssue({ id: "a", project_id: null, module_id: null, work_item_id: null }),
      makeIssue({ id: "b", project_id: null, module_id: null, work_item_id: null }),
    ]);
    expect(common.scope).toEqual({
      project_id: null,
      module_id: null,
      work_item_id: null,
    });
  });

  it("returns null scope when project, module, or work item differs", () => {
    expect(
      commonIssueFields([
        makeIssue({ id: "a", project_id: "p-1", module_id: "m-1", work_item_id: "wi-1" }),
        makeIssue({ id: "b", project_id: "p-1", module_id: "m-1", work_item_id: "wi-2" }),
      ]).scope,
    ).toBeNull();
    expect(
      commonIssueFields([
        makeIssue({ id: "a", project_id: "p-1", module_id: "m-1" }),
        makeIssue({ id: "b", project_id: "p-1", module_id: null }),
      ]).scope,
    ).toBeNull();
  });
});

describe("findBatchScopeParentConflicts", () => {
  const scopeA = { project_id: "p-1", module_id: "m-1", work_item_id: "wi-1" };
  const scopeSiblingWI = { project_id: "p-1", module_id: "m-1", work_item_id: "wi-2" };
  const scopeB = { project_id: "p-2", module_id: "m-2", work_item_id: null };
  const emptyScope = { project_id: null, module_id: null, work_item_id: null };

  it("compares scopes treating undefined and null identically", () => {
    expect(sameIssueScope({ project_id: "p-1" }, { project_id: "p-1", module_id: null, work_item_id: null })).toBe(true);
    expect(sameIssueScope(scopeA, scopeSiblingWI)).toBe(false);
  });

  it("allows moving standalone issues and parents without their children selected", () => {
    const parent = makeIssue({ id: "p", identifier: "BIO-1", ...scopeA });
    const child = makeIssue({ id: "c", identifier: "BIO-2", parent_issue_id: "p", ...scopeA });
    const standalone = makeIssue({ id: "s", identifier: "BIO-3", ...scopeA });

    expect(findBatchScopeParentConflicts([parent, standalone], scopeB, [parent, child, standalone])).toEqual([]);
  });

  it("blocks moving a sub-issue without its parent to a different project, module, work item, or unfiled", () => {
    const parent = makeIssue({ id: "p", identifier: "BIO-1", title: "Parent", ...scopeA });
    const child = makeIssue({ id: "c", identifier: "BIO-2", title: "Child", parent_issue_id: "p", ...scopeA });
    const standalone = makeIssue({ id: "s", identifier: "BIO-3", ...scopeA });

    for (const target of [scopeB, scopeSiblingWI, emptyScope]) {
      const conflicts = findBatchScopeParentConflicts([standalone, child], target, [parent, child, standalone]);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toEqual({ issue: child, parentId: "p", parent });
    }
  });

  it("allows moving parent and child together to a new ownership", () => {
    const parent = makeIssue({ id: "p", identifier: "BIO-1", ...scopeA });
    const child = makeIssue({ id: "c", identifier: "BIO-2", parent_issue_id: "p", ...scopeA });

    expect(findBatchScopeParentConflicts([child, parent], scopeB, [parent, child])).toEqual([]);
  });

  it("allows moving grandparent and grandchild together while flagging child+grandchild without grandparent", () => {
    const gp = makeIssue({ id: "gp", identifier: "BIO-1", ...scopeA });
    const p = makeIssue({ id: "p", identifier: "BIO-2", parent_issue_id: "gp", ...scopeA });
    const c = makeIssue({ id: "c", identifier: "BIO-3", parent_issue_id: "p", ...scopeA });

    expect(findBatchScopeParentConflicts([gp, c], scopeB, [gp, p, c])).toEqual([]);

    const conflicts = findBatchScopeParentConflicts([p, c], scopeB, [gp, p, c]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.issue.id).toBe("p");
    expect(conflicts[0]?.parentId).toBe("gp");
  });

  it("allows a sub-issue when target matches its current scope or realigns to its parent's scope", () => {
    const parent = makeIssue({ id: "p", ...scopeB });
    const legacyChild = makeIssue({ id: "c", parent_issue_id: "p", ...scopeA });

    expect(findBatchScopeParentConflicts([legacyChild], scopeA, [parent, legacyChild])).toEqual([]);
    expect(findBatchScopeParentConflicts([legacyChild], scopeB, [parent, legacyChild])).toEqual([]);
  });

  it("flags a sub-issue whose parent is outside the loaded issue list", () => {
    const child = makeIssue({ id: "c", identifier: "BIO-9", parent_issue_id: "unloaded-parent", ...scopeA });
    const conflicts = findBatchScopeParentConflicts([child], scopeB, [child]);
    expect(conflicts).toEqual([{ issue: child, parentId: "unloaded-parent", parent: null }]);
  });
});
