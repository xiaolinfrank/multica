// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cockpitWorkflowActions } from "./meeting-workflow";
import { versionFixture, workflowFixture } from "./workflow-test-fixtures";

describe("meeting workflow affordances", () => {
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
