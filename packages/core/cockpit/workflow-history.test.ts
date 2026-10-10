// @vitest-environment node
import { describe, expect, it } from "vitest";
import { acknowledgedCockpitWorkflowCommand, cockpitWorkflowSummaryActions, cockpitWorkflowSummaryPollInterval, mergeCockpitWorkflowSummary } from "./workflow-history";
import { workflowSummaryFixture, versionMetadataFixture, compactFixture } from "./workflow-history-test-fixtures";
import { workflowFixture, versionFixture, nasExportFixture } from "./workflow-test-fixtures";

function publishedSummary() {
  const version = versionFixture({ decision: "approved", published_at: "2026-10-10T10:00:00Z" });
  const summary = workflowSummaryFixture(workflowFixture({ current_version_id: version.id, published_version_id: version.id, versions: [version],
    nas_destination: { root_id: "nas-root-1", directory: "/Volumes/team/Meeting" } }));
  return { ...summary, published_nas_export: { ...nasExportFixture(), source_version: versionMetadataFixture(version) },
    history_counts: { ...summary.history_counts, nas_exports: 1, nas_active: 1 } };
}

describe("bounded workflow state", () => {
  it("acknowledges same-revision retry no-ops only for already accepted execution states with the same frozen operation", () => {
    const summary = publishedSummary();
    const operation = { ...summary.published_nas_export, revision: 3, status: "retry_wait", can_retry: true };
    const command = { action: "nas_export_retried" as const, operation };
    for (const status of ["queued", "running", "succeeded"]) {
      const job = { ...operation, status, can_retry: false, ...(status === "succeeded" ? { completed_at: "2026-10-10T10:00:00Z", size_bytes: 42 } : {}) };
      expect(acknowledgedCockpitWorkflowCommand(compactFixture(summary, { action: command.action, nas_export: job }), command)).toBe(true);
    }
    for (const status of ["retry_wait", "needs_attention", "future-state"]) {
      expect(acknowledgedCockpitWorkflowCommand(compactFixture(summary, { action: command.action, nas_export: { ...operation, status } }), command)).toBe(false);
    }
    for (const patch of [{ revision: 2 }, { target_path: "/Volumes/team/Other.md" }, { id: "another-operation" }, { content_hash: "another-document" }]) {
      expect(acknowledgedCockpitWorkflowCommand(compactFixture(summary, { action: command.action, nas_export: { ...operation, status: "queued", ...patch } }), command)).toBe(false);
    }
  });

  it("uses exact metadata pins for capabilities without downloading document bodies", () => {
    const version = versionFixture();
    const summary = workflowSummaryFixture(workflowFixture({ current_version_id: version.id, versions: [version] }));
    expect(summary.current_version).not.toHaveProperty("content");
    expect(cockpitWorkflowSummaryActions(summary, "reviewer-1").canReview).toBe(true);
    expect(cockpitWorkflowSummaryActions({ ...summary, current_version_id: "another-version" }, "reviewer-1").valid).toBe(false);
    expect(cockpitWorkflowSummaryActions({ ...summary, current_version: { ...summary.current_version!, decision: "future-outcome" } }, "reviewer-1"))
      .toMatchObject({ canReview: false, canPublish: false, canSubmit: false });
  });

  it("does not lose a just-created operation to an older same-revision null snapshot or stop its polling", () => {
    const current = publishedSummary();
    const stale = { ...current, published_nas_export: null, history_counts: { ...current.history_counts, nas_exports: 0, nas_active: 0 } };
    const merged = mergeCockpitWorkflowSummary(current, stale);
    expect(merged.published_nas_export?.id).toBe(current.published_nas_export.id);
    expect(merged.history_counts).toMatchObject({ nas_exports: 1, nas_active: 1 });
    expect(cockpitWorkflowSummaryPollInterval(merged, 20_000, 10_000)).toBe(10_000);
    expect(cockpitWorkflowSummaryPollInterval(merged, 20_000, 20_000)).toBe(false);
    expect(merged).not.toHaveProperty("nas_exports");
  });

  it("keeps newer operation state without copying old retry authority over an incoming denial", () => {
    const current = publishedSummary();
    current.published_nas_export = { ...current.published_nas_export, status: "retry_wait", revision: 4, can_retry: true };
    const incoming = { ...current, published_nas_export: { ...current.published_nas_export, revision: 2, status: "queued", can_retry: false } };
    expect(mergeCockpitWorkflowSummary(current, incoming).published_nas_export).toMatchObject({ revision: 4, status: "retry_wait", can_retry: false });
    const completed = { ...current, published_nas_export: { ...current.published_nas_export, revision: 5, status: "succeeded", can_retry: false }, history_counts: { ...current.history_counts, nas_active: 0 } };
    expect(mergeCockpitWorkflowSummary(current, completed).history_counts.nas_active).toBe(0);
  });

  it("drops the old destination pin when the configured directory or official version changes", () => {
    const current = publishedSummary();
    const changedDestination = { ...current, nas_destination: { ...current.nas_destination!, directory: "/Volumes/team/New" }, published_nas_export: null };
    expect(mergeCockpitWorkflowSummary(current, changedDestination).published_nas_export).toBeNull();
    expect(mergeCockpitWorkflowSummary(current, { ...current, published_version_id: "new-version", published_nas_export: null }).published_nas_export).toBeNull();
  });
});
