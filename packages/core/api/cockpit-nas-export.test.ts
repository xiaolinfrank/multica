// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { CockpitMeetingWorkflowSchema } from "./schemas";
import { CockpitUnconfirmedWriteError } from "../cockpit/errors";
import { nasExportFixture, versionFixture, workflowFixture, WORKFLOW_MEETING_ID } from "../cockpit/workflow-test-fixtures";

afterEach(() => vi.unstubAllGlobals());
const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const destination = { root_id: "nas-root-1", directory: "/Volumes/team/Meeting" };
function publishedWorkflow() {
  const version = versionFixture({ decision: "approved", published_at: "2026-10-09T12:00:00Z" });
  return workflowFixture({ revision: 4, versions: [version], current_version_id: version.id, published_version_id: version.id,
    nas_destination: destination, can_export_nas: true, nas_exports: [nasExportFixture()] });
}

describe("fixed minutes NAS export API", () => {
  it("keeps older reads usable without inventing an export or valid destination", () => {
    expect(CockpitMeetingWorkflowSchema.parse({ meeting_id: WORKFLOW_MEETING_ID })).toMatchObject({
      nas_destination: null, nas_unavailable_reason: "", can_export_nas: false, nas_exports: [],
    });
    expect(CockpitMeetingWorkflowSchema.parse({ meeting_id: WORKFLOW_MEETING_ID, nas_destination: { root_id: "root" }, can_export_nas: "yes" }))
      .toMatchObject({ nas_destination: null, can_export_nas: false });
    expect(CockpitMeetingWorkflowSchema.parse({ ...publishedWorkflow(), nas_exports: [nasExportFixture({ status: "future-export-state" })] }).nas_exports[0]?.status)
      .toBe("future-export-state");
  });

  it("acknowledges publication with a durable queued export, without pretending the NAS file exists", async () => {
    const result = publishedWorkflow();
    const fetchMock = vi.fn().mockResolvedValue(respond(result));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("https://example.test");
    await expect(client.publishCockpitMinutesVersion(WORKFLOW_MEETING_ID, "version-1", 3, destination)).resolves.toMatchObject({
      published_version_id: "version-1", nas_exports: [{ status: "queued", completed_at: null, target_path: nasExportFixture().target_path }],
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ expected_revision: 3, nas_export: destination });
  });

  it("rejects a publish acknowledgment when the requested NAS operation is absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond({ ...publishedWorkflow(), nas_exports: [] })));
    await expect(new ApiClient("https://example.test").publishCockpitMinutesVersion(WORKFLOW_MEETING_ID, "version-1", 3, destination))
      .rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
  });

  it("exports the official version even while a newer version is under review", async () => {
    const result = publishedWorkflow();
    result.current_version_id = "version-2";
    result.versions.push(versionFixture({ id: "version-2", version_number: 2, submission_key: "20000000-0000-4000-8000-000000000002" }));
    const fetchMock = vi.fn().mockResolvedValue(respond(result));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new ApiClient("https://example.test").exportCockpitMinutesToNas(WORKFLOW_MEETING_ID, "version-1", destination))
      .resolves.toMatchObject({ current_version_id: "version-2", published_version_id: "version-1" });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/versions/version-1/nas-export"), expect.objectContaining({ body: JSON.stringify(destination) }));
  });

  it("refuses mismatched identity, content, destination and defaulted operation fields", async () => {
    const result = publishedWorkflow();
    const job = nasExportFixture();
    const wrong = [
      { ...result, nas_exports: [] },
      { ...result, nas_exports: [{ ...job, content_hash: "other-content" }] },
      { ...result, nas_exports: [{ ...job, source_issue_id: "other-source" }] },
      { ...result, nas_exports: [{ ...job, root_id: "other-root" }] },
      { ...result, nas_exports: [{ ...job, directory: "/Volumes/team/Other meeting" }] },
      { ...result, nas_exports: [{ ...job, target_path: "" }] },
      { ...result, nas_exports: [{ ...job, attempts: undefined }] },
      { ...result, nas_exports: [{ ...job, status: "succeeded", completed_at: null }] },
    ];
    const fetchMock = vi.fn();
    for (const body of wrong) fetchMock.mockResolvedValueOnce(respond(body));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("https://example.test");
    for (const _body of wrong) await expect(client.exportCockpitMinutesToNas(WORKFLOW_MEETING_ID, "version-1", destination))
      .rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
  });

  it("retries only the frozen operation and rejects a silently changed target or unchanged revision", async () => {
    const operation = nasExportFixture({ revision: 3, status: "retry_wait", can_retry: true });
    const result = publishedWorkflow();
    const fetchMock = vi.fn().mockResolvedValueOnce(respond({ ...result, nas_exports: [{ ...operation, revision: 4, status: "queued" }] }))
      .mockResolvedValueOnce(respond({ ...result, nas_exports: [{ ...operation, revision: 4, target_path: "/Volumes/team/Meeting/elsewhere.md" }] }))
      .mockResolvedValueOnce(respond({ ...result, nas_exports: [operation] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("https://example.test");
    await expect(client.retryCockpitNasExport(WORKFLOW_MEETING_ID, operation)).resolves.toMatchObject({ nas_exports: [{ revision: 4 }] });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ expected_revision: 3 });
    await expect(client.retryCockpitNasExport(WORKFLOW_MEETING_ID, operation)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    await expect(client.retryCockpitNasExport(WORKFLOW_MEETING_ID, operation)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
  });
});
