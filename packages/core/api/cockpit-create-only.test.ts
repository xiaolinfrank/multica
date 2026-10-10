// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { CockpitUnconfirmedWriteError } from "../cockpit/errors";
import { nasExportFixture, versionFixture, workflowFixture, WORKFLOW_MEETING_ID } from "../cockpit/workflow-test-fixtures";
import { compactFixture, workflowSummaryFixture, versionMetadataFixture } from "../cockpit/workflow-history-test-fixtures";
import { cockpitNasCopyEvidenceValid, cockpitNasDestination } from "../cockpit/nas-export";

const operationId = "70000000-0000-4000-8000-000000000001";
const attemptId = "80000000-0000-4000-8000-000000000001";
const destination = { root_id: "root", directory: "/Volumes/team/Meeting", write_mode: "create_only" };
const logical = `${destination.directory}/已发布纪要/创建式副本/minutes.md`;
const attemptDir = `${destination.directory}/已发布纪要/创建式副本/${operationId}/${attemptId}`;
function completeJob() { return nasExportFixture({ ...destination, id: operationId, target_path: logical, status: "succeeded", size_bytes: 18,
  completed_at: "2026-10-10T00:00:00Z", verified_path: `${attemptDir}/minutes.md`, receipt_path: `${attemptDir}/.multica-complete.json`,
  verified_attempt_id: attemptId, receipt_hash: "a".repeat(64) }); }
function published() {
  const version = versionFixture({ decision: "approved", published_at: "2026-10-10T00:00:00Z" });
  const workflow = workflowSummaryFixture(workflowFixture({ versions: [version], current_version_id: version.id, published_version_id: version.id, nas_destination: destination }));
  const job = { ...completeJob(), source_version: versionMetadataFixture(version) };
  return { workflow, job, result: compactFixture(workflow, { action: "nas_export_queued", nas_export: job }) };
}
function reply(body: unknown) {
  const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock); return { client: new ApiClient("https://example.test"), fetchMock };
}
afterEach(() => vi.unstubAllGlobals());

describe("create-only NAS evidence", () => {
  it("explicitly transmits the mode and acknowledges the separate verified path", async () => {
    const { workflow, result } = published();
    const { client, fetchMock } = reply(result);
    const received = await client.commandCockpitMeetingWorkflow(workflow.workspace_id, WORKFLOW_MEETING_ID,
      { action: "nas_export_queued", version_id: "version-1", body: destination });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual(destination);
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get("X-Workspace-ID")).toBe(workflow.workspace_id);
    expect(received.receipt.nas_export?.verified_path).toBe(`${attemptDir}/minutes.md`);
    expect(received.receipt.nas_export?.verified_path).not.toBe(logical);
  });
  it("refuses silent atomic fallback, missing completion records and mismatched attempt identities", async () => {
    const { workflow, job, result } = published();
    for (const patch of [{ write_mode: "atomic" }, { write_mode: undefined }, { write_mode: "future-mode" },
      { receipt_hash: null }, { receipt_path: logical }, { verified_path: logical }, { verified_attempt_id: operationId }, { size_bytes: 0 }, { verified_attempt_id: "00000000-0000-0000-0000-000000000000" }]) {
      const { client } = reply({ ...result, receipt: { ...result.receipt, nas_export: { ...job, ...patch } } });
      await expect(client.commandCockpitMeetingWorkflow(workflow.workspace_id, WORKFLOW_MEETING_ID,
        { action: "nas_export_queued", version_id: "version-1", body: destination })).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
  });
  it("keeps old atomic servers usable while unknown configured modes cannot grant exports", () => {
    expect(cockpitNasCopyEvidenceValid(nasExportFixture())).toBe(true);
    expect(cockpitNasCopyEvidenceValid(completeJob())).toBe(true);
    expect(cockpitNasDestination({ nas_destination: { ...destination, write_mode: "future" } })).toBeNull();
    expect(cockpitNasCopyEvidenceValid({ ...completeJob(), target_path: `${destination.directory}/../minutes.md` })).toBe(false);
  });
  it("loads only one scoped metadata page and rejects overflow or missing evidence", async () => {
    const row = { id: attemptId, attempt_number: 1, status: "verified", target_path: `${attemptDir}/minutes.md`, receipt_path: `${attemptDir}/.multica-complete.json`,
      content_hash: "b".repeat(64), verified_path: `${attemptDir}/minutes.md`, verified_receipt_path: `${attemptDir}/.multica-complete.json`,
      verified_attempt_id: attemptId, receipt_hash: "a".repeat(64), size_bytes: 18, last_error_code: "", last_error: "", created_at: "2026-10-10", updated_at: "2026-10-10", verified_at: "2026-10-10" };
    const page = { workspace_id: "ws", meeting_id: WORKFLOW_MEETING_ID, export_id: operationId, items: [row], total: 1, next_cursor: null };
    const { client, fetchMock } = reply(page);
    await expect(client.getCockpitNasExportAttempts("ws", WORKFLOW_MEETING_ID, operationId, { page_size: 25, cursor: "opaque" })).resolves.toEqual(page);
    expect(String(fetchMock.mock.calls[0]![0])).toContain(`/exports/${operationId}/attempts?page_size=25&cursor=opaque`);
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get("X-Workspace-ID")).toBe("ws");
    for (const invalid of [{ ...page, workspace_id: "other" }, { ...page, export_id: "other" }, { ...page, items: Array(26).fill(row) },
      { ...page, items: [{ ...row, verified_receipt_path: null }] }]) {
      await expect(reply(invalid).client.getCockpitNasExportAttempts("ws", WORKFLOW_MEETING_ID, operationId)).resolves.toBeNull();
    }
  });
});
