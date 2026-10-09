// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { CockpitBoardSchema, CockpitMeetingWorkflowSchema, CockpitMeetingWorkflowWriteSchema, CockpitReviewerHandoffSchema } from "./schemas";
import { CockpitUnconfirmedWriteError } from "../cockpit/errors";
import { handoffFixture, versionFixture, workflowFixture, WORKFLOW_MEETING_ID, WORKFLOW_SUBMISSION_KEY, WORKFLOW_HANDOFF_KEY } from "../cockpit/workflow-test-fixtures";

afterEach(() => vi.unstubAllGlobals());
const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

describe("meeting workflow boundary", () => {
  it("defaults an unenabled read but rejects incomplete enabled write acknowledgments", () => {
    expect(CockpitBoardSchema.parse({ cockpit: { id: "cp" } }).has_meeting_workflows).toBe(false);
    expect(CockpitBoardSchema.parse({ cockpit: { id: "cp" }, has_meeting_workflows: true }).has_meeting_workflows).toBe(true);
    expect(CockpitMeetingWorkflowSchema.parse({ meeting_id: WORKFLOW_MEETING_ID, enabled: false })).toMatchObject({
      enabled: false, revision: 0, minutes_issue: null, versions: [], can_submit: false, can_review: false,
      can_reassign_reviewer: false, reviewer_handoffs: [],
    });
    expect(CockpitMeetingWorkflowWriteSchema.safeParse({ meeting_id: WORKFLOW_MEETING_ID, enabled: true }).success).toBe(false);
    const { can_submit: _canSubmit, ...incomplete } = workflowFixture();
    expect(CockpitMeetingWorkflowWriteSchema.safeParse(incomplete).success).toBe(false);
    expect(CockpitReviewerHandoffSchema.parse(handoffFixture())).toMatchObject({
      from_reviewer_name: "", to_reviewer_name: "", created_by_name: "",
    });
    expect(CockpitReviewerHandoffSchema.parse({ ...handoffFixture(), from_reviewer_name: null, to_reviewer_name: 4 })).toMatchObject({
      from_reviewer_name: "", to_reviewer_name: "", created_by_name: "",
    });
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

  it("acknowledges a precise handoff receipt even after a subsequent transfer, without changing fixed content", async () => {
    const handoff = handoffFixture();
    const version = versionFixture({ reviewer_id: "reviewer-3", review_issue: { ...handoff.to_review_issue!, id: "review-3", assignee_id: "reviewer-3" } });
    const result = workflowFixture({ reviewer_id: "reviewer-3", revision: 6, current_version_id: version.id, versions: [version], reviewer_handoffs: [handoff] });
    const fetchMock = vi.fn().mockResolvedValue(respond(result));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("https://example.test");
    const body = { expected_revision: 1, handoff_key: WORKFLOW_HANDOFF_KEY, reviewer_id: "reviewer-2", reason: " Reviewer left the team \n" };
    await expect(client.reassignCockpitMeetingReviewer(WORKFLOW_MEETING_ID, body)).resolves.toMatchObject({ reviewer_id: "reviewer-3", versions: [version] });
    expect(fetchMock).toHaveBeenCalledWith(`https://example.test/api/cockpit/meetings/${WORKFLOW_MEETING_ID}/workflow/reviewer`, expect.objectContaining({
      method: "POST", body: JSON.stringify({ ...body, reason: "Reviewer left the team" }),
    }));
  });

  it("rejects ignored or malformed handoff acknowledgments instead of reporting a transfer", async () => {
    const handoff = handoffFixture();
    const full = workflowFixture({ revision: 2, current_version_id: "version-1", versions: [versionFixture()], reviewer_handoffs: [handoff] });
    const cases: unknown[] = [workflowFixture(), { ...full, reviewer_handoffs: {} },
      { ...full, reviewer_handoffs: [{ ...handoff, created_by: undefined }] },
      { ...full, reviewer_handoffs: [{ ...handoff, handoff_key: WORKFLOW_SUBMISSION_KEY }] },
      { ...full, reviewer_handoffs: [{ ...handoff, to_reviewer_id: "someone-else" }] },
      { ...full, reviewer_handoffs: [{ ...handoff, reason: "different reason" }] },
      { ...full, revision: 3, reviewer_handoffs: [{ ...handoff, revision: 3 }] },
      { ...full, reviewer_handoffs: [{ ...handoff, version_id: "missing-version" }] },
      { ...full, reviewer_handoffs: [{ ...handoff, to_review_issue: handoff.from_review_issue }] }];
    const fetchMock = vi.fn();
    for (const value of cases) fetchMock.mockResolvedValueOnce(respond(value));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("https://example.test");
    for (const _value of cases) await expect(client.reassignCockpitMeetingReviewer(WORKFLOW_MEETING_ID, {
      expected_revision: 1, handoff_key: WORKFLOW_HANDOFF_KEY, reviewer_id: "reviewer-2", reason: handoff.reason,
    })).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
  });
});
