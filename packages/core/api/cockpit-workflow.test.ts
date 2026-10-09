// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { CockpitBoardSchema, CockpitMeetingWorkflowSchema, CockpitMeetingWorkflowWriteSchema } from "./schemas";
import { CockpitUnconfirmedWriteError } from "../cockpit/errors";
import { versionFixture, workflowFixture, WORKFLOW_MEETING_ID, WORKFLOW_SUBMISSION_KEY } from "../cockpit/workflow-test-fixtures";

afterEach(() => vi.unstubAllGlobals());
const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

describe("meeting workflow boundary", () => {
  it("defaults an unenabled read but rejects incomplete enabled write acknowledgments", () => {
    expect(CockpitBoardSchema.parse({ cockpit: { id: "cp" } }).has_meeting_workflows).toBe(false);
    expect(CockpitBoardSchema.parse({ cockpit: { id: "cp" }, has_meeting_workflows: true }).has_meeting_workflows).toBe(true);
    expect(CockpitMeetingWorkflowSchema.parse({ meeting_id: WORKFLOW_MEETING_ID, enabled: false })).toMatchObject({
      enabled: false, revision: 0, minutes_issue: null, versions: [], can_submit: false, can_review: false,
    });
    expect(CockpitMeetingWorkflowWriteSchema.safeParse({ meeting_id: WORKFLOW_MEETING_ID, enabled: true }).success).toBe(false);
    const { can_submit: _canSubmit, ...incomplete } = workflowFixture();
    expect(CockpitMeetingWorkflowWriteSchema.safeParse(incomplete).success).toBe(false);
  });

  it("refuses HTTP success that did not confirm initialization or readiness", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(respond({ enabled: true, meeting_id: WORKFLOW_MEETING_ID, revision: 1 }))
      .mockResolvedValueOnce(respond(workflowFixture())));
    const client = new ApiClient("https://example.test");
    await expect(client.enableCockpitMeetingWorkflow(WORKFLOW_MEETING_ID, { reviewer_id: "reviewer-1" })).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    await expect(client.updateCockpitMeetingReadiness(WORKFLOW_MEETING_ID, { expected_revision: 1, ended: true })).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
  });

  it("trims submitted text and verifies the exact idempotency key without inventing a version", async () => {
    const version = versionFixture();
    const result = workflowFixture({ revision: 2, current_version_id: version.id, versions: [version] });
    const fetchMock = vi.fn().mockResolvedValueOnce(respond(result))
      .mockResolvedValueOnce(respond({ ...result, versions: [{ ...version, submission_key: "20000000-0000-4000-8000-000000000099" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("https://example.test");
    const body = { expected_revision: 1, submission_key: WORKFLOW_SUBMISSION_KEY, content: "  Fixed minutes text\n" };
    await expect(client.submitCockpitMinutesVersion(WORKFLOW_MEETING_ID, body)).resolves.toMatchObject({ current_version_id: version.id });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ ...body, content: "Fixed minutes text" });
    await expect(client.submitCockpitMinutesVersion(WORKFLOW_MEETING_ID, body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
  });

  it("does not turn a done review issue into approval or accept publishing a different version", async () => {
    const version = versionFixture();
    version.review_issue.status = "done";
    const current = workflowFixture({ current_version_id: version.id, versions: [version] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(respond(current))
      .mockResolvedValueOnce(respond({ ...current, current_version_id: "version-2", published_version_id: version.id,
        versions: [{ ...version, decision: "approved", published_at: "2026-10-09T11:00:00Z", published_by: "reviewer-1" }] })));
    const client = new ApiClient("https://example.test");
    await expect(client.reviewCockpitMinutesVersion(WORKFLOW_MEETING_ID, version.id, { expected_revision: 1, decision: "approved", feedback: "" })).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    await expect(client.publishCockpitMinutesVersion(WORKFLOW_MEETING_ID, version.id, 1)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
  });

  it("acknowledges an idempotent published-version retry after the next review round starts", async () => {
    const published = versionFixture({ decision: "approved", published_at: "2026-10-09T11:00:00Z", published_by: "reviewer-1" });
    const current = versionFixture({ id: "version-2", version_number: 2, submission_key: "20000000-0000-4000-8000-000000000002" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(workflowFixture({ revision: 8,
      current_version_id: current.id, published_version_id: published.id, versions: [current, published] }))));
    const client = new ApiClient("https://example.test");
    await expect(client.publishCockpitMinutesVersion(WORKFLOW_MEETING_ID, published.id, 4))
      .resolves.toMatchObject({ published_version_id: published.id, current_version_id: current.id });
  });
});
