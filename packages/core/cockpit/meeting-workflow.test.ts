// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cockpitWorkflowActions, cockpitWorkflowRequiredIssueRoles } from "./meeting-workflow";
import { handoffFixture, versionFixture, workflowFixture } from "./workflow-test-fixtures";

describe("meeting workflow affordances", () => {
  it("retains old and replacement review relations after multiple handoffs, without protecting another meeting", () => {
    const old = handoffFixture();
    const next = handoffFixture({ id: "handoff-2", from_review_issue: old.to_review_issue,
      to_review_issue: { ...old.to_review_issue!, id: "review-3" } });
    const workflow = workflowFixture({ versions: [versionFixture({ review_issue: next.to_review_issue! })], reviewer_handoffs: [old, next] });
    expect([...cockpitWorkflowRequiredIssueRoles(workflow)]).toEqual([
      ["minutes-1", ["minutes"]], ["review-3", ["review"]], ["review-1", ["review"]], ["review-2", ["review"]],
    ]);
    expect(cockpitWorkflowRequiredIssueRoles(workflowFixture()).has("review-1")).toBe(false);
  });
  it("requires both manager authority and the handoff capability without treating unknown states as transferable", () => {
    const workflow = workflowFixture({ can_reassign_reviewer: true });
    expect(cockpitWorkflowActions(workflow, "manager-1").canReassignReviewer).toBe(true);
    expect(cockpitWorkflowActions({ ...workflow, can_manage: false }, "member-1").canReassignReviewer).toBe(false);
    expect(cockpitWorkflowActions({ ...workflow, can_reassign_reviewer: false }, "manager-1").canReassignReviewer).toBe(false);
    expect(cockpitWorkflowActions(workflow, "").canReassignReviewer).toBe(false);
    expect(cockpitWorkflowActions({ ...workflow, current_version_id: "version-1", versions: [versionFixture({ decision: "future-decision" })] }, "manager-1").canReassignReviewer).toBe(false);
  });
  it("requires both facts and backlog before explicit release", () => {
    const workflow = workflowFixture({ ended_at: "2026-10-09T10:00:00Z", materials_ready: true });
    expect(cockpitWorkflowActions(workflow, "manager-1").canRelease).toBe(true);
    expect(cockpitWorkflowActions({ ...workflow, ended_at: null }, "manager-1").canRelease).toBe(false);
    expect(cockpitWorkflowActions({ ...workflow, materials_ready: false }, "manager-1").canRelease).toBe(false);
    expect(cockpitWorkflowActions({ ...workflow, minutes_issue: { ...workflow.minutes_issue!, status: "done" } }, "manager-1").canRelease).toBe(false);
  });

  it("does not convert a manually closed or reassigned review issue into approval", () => {
    const version = versionFixture();
    version.review_issue = { ...version.review_issue, status: "done", assignee_type: "agent", assignee_id: "agent-1" };
    const workflow = workflowFixture({ current_version_id: version.id, versions: [version] });
    const actions = cockpitWorkflowActions(workflow, "reviewer-1");
    expect(actions.canReview).toBe(true);
    expect(actions.canPublish).toBe(false);
    expect(cockpitWorkflowActions(workflow, "another-admin").canReview).toBe(false);
  });

  it("allows a designated human writer to submit but not manage readiness", () => {
    const workflow = workflowFixture({ can_manage: false, released_at: "2026-10-09T10:00:00Z" });
    expect(cockpitWorkflowActions(workflow, "writer-1")).toMatchObject({ canManage: false, canSubmit: true });
    expect(cockpitWorkflowActions(workflow, "another-member").canSubmit).toBe(false);
  });

  it("requires an approved current version and permission to publish", () => {
    const version = versionFixture({ decision: "approved" });
    const workflow = workflowFixture({ current_version_id: version.id, versions: [version] });
    expect(cockpitWorkflowActions(workflow, "reviewer-1").canPublish).toBe(true);
    expect(cockpitWorkflowActions({ ...workflow, can_publish: false }, "reviewer-1").canPublish).toBe(false);
    expect(cockpitWorkflowActions({ ...workflow, published_version_id: version.id }, "reviewer-1").canPublish).toBe(false);
    expect(cockpitWorkflowActions({ ...workflow, current_version_id: "missing" }, "reviewer-1").valid).toBe(false);
  });

  it("keeps future review states readable without treating them as final", () => {
    const version = versionFixture({ decision: "awaiting-countersign" });
    const actions = cockpitWorkflowActions(workflowFixture({ released_at: "2026-10-09T10:00:00Z", current_version_id: version.id, versions: [version] }), "reviewer-1");
    expect(actions.current?.decision).toBe("awaiting-countersign");
    expect(actions).toMatchObject({ canReview: false, canPublish: false, canSubmit: false });
  });
});
