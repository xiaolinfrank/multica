// @vitest-environment node
import { describe, expect, it } from "vitest";
import { canRetryCockpitNasExport, cockpitNasDestination, cockpitNasExportActions, cockpitNasPollInterval, mergeCockpitWorkflowResponse } from "./nas-export";
import { nasExportFixture, versionFixture, workflowFixture } from "./workflow-test-fixtures";

function exportedWorkflow() {
  const version = versionFixture({ decision: "approved", published_at: "2026-10-09T12:00:00Z" });
  return workflowFixture({ versions: [version], published_version_id: version.id, current_version_id: version.id,
    can_export_nas: true, nas_destination: { root_id: "nas-root-1", directory: "/Volumes/team/Meeting" } });
}

describe("NAS export affordances", () => {
  it("retains newer worker results and newly queued exports without rolling back newer business state", () => {
    const current = exportedWorkflow();
    current.revision = 8;
    current.reviewer_id = "new-reviewer";
    current.nas_exports = [nasExportFixture({ revision: 5, status: "succeeded", completed_at: "2026-10-09T12:01:00Z", size_bytes: 23 })];
    const delayed = { ...exportedWorkflow(), revision: 7, nas_exports: [nasExportFixture({ revision: 2 }), nasExportFixture({ id: "operation-2", directory: "/Volumes/team/New" })] };
    const merged = mergeCockpitWorkflowResponse(current, delayed);
    expect(merged).toMatchObject({ revision: 8, reviewer_id: "new-reviewer", nas_exports: [
      { id: "nas-operation-1", revision: 5, status: "succeeded" }, { id: "operation-2", revision: 1 },
    ] });
    expect(mergeCockpitWorkflowResponse(merged, { ...delayed, revision: 9 }).revision).toBe(9);
    expect(mergeCockpitWorkflowResponse(merged, { ...delayed, revision: 9 }).nas_exports[0]?.revision).toBe(5);
  });
  it("uses the published version and suppresses duplicate exports to a previously requested destination", () => {
    const workflow = exportedWorkflow();
    workflow.versions.push(versionFixture({ id: "version-2", version_number: 2 }));
    workflow.current_version_id = "version-2";
    expect(cockpitNasExportActions(workflow, "reviewer-1")).toMatchObject({ published: { id: "version-1" }, canExport: true });
    workflow.nas_exports = [nasExportFixture()];
    expect(cockpitNasExportActions(workflow, "reviewer-1").canExport).toBe(false);
    workflow.nas_destination = { root_id: "nas-root-1", directory: "/Volumes/team/New meeting folder" };
    expect(cockpitNasExportActions(workflow, "reviewer-1").canExport).toBe(true);
    expect(workflow.nas_exports[0]?.directory).toBe("/Volumes/team/Meeting");
  });

  it("requires authority and matching fixed-version evidence for mutations, preserving unknown states as read-only", () => {
    const workflow = exportedWorkflow();
    const retry = nasExportFixture({ status: "retry_wait", can_retry: true });
    expect(canRetryCockpitNasExport(workflow, retry, "reviewer-1")).toBe(true);
    expect(canRetryCockpitNasExport(workflow, { ...retry, status: "future-state" }, "reviewer-1")).toBe(false);
    expect(canRetryCockpitNasExport(workflow, { ...retry, content_hash: "different" }, "reviewer-1")).toBe(false);
    expect(canRetryCockpitNasExport(workflow, retry, "")).toBe(false);
    expect(cockpitNasExportActions({ ...workflow, can_export_nas: false }, "reviewer-1").canExport).toBe(false);
    expect(cockpitNasExportActions({ ...workflow, can_manage: false }, "another-human").canExport).toBe(false);
    expect(cockpitNasDestination({ ...workflow, nas_destination: { root_id: "root", directory: "relative/folder" } })).toBeNull();
  });

  it("polls only known active jobs inside the selected meeting's bounded window", () => {
    const workflow = exportedWorkflow();
    expect(cockpitNasPollInterval(workflow, 300_000, 1000)).toBe(false);
    workflow.nas_exports = [nasExportFixture()];
    expect(cockpitNasPollInterval(workflow, 300_000, 1000)).toBe(10_000);
    expect(cockpitNasPollInterval(workflow, 300_000, 300_000)).toBe(false);
    workflow.nas_exports[0]!.status = "succeeded";
    expect(cockpitNasPollInterval(workflow, 300_000, 1000)).toBe(false);
    workflow.nas_exports[0]!.status = "future-state";
    expect(cockpitNasPollInterval(workflow, 300_000, 1000)).toBe(false);
  });
});
