// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { CockpitUnconfirmedWriteError } from "../cockpit/errors";
import { compactFixture, HISTORY_WORKSPACE_ID as WS, versionMetadataFixture, workflowSummaryFixture } from "../cockpit/workflow-history-test-fixtures";
import { handoffFixture, nasExportFixture, versionFixture, workflowFixture, WORKFLOW_HANDOFF_KEY, WORKFLOW_MEETING_ID as MEETING, WORKFLOW_SUBMISSION_KEY } from "../cockpit/workflow-test-fixtures";

const client = () => new ApiClient("https://example.test");
const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const page = (items: unknown[] = []) => ({ workspace_id: WS, meeting_id: MEETING, workflow_revision: 90, total: items.length, items, next_cursor: null });
const show = (data: unknown) => { const fetch = vi.fn().mockResolvedValue(respond(data)); vi.stubGlobal("fetch", fetch); return fetch; };
afterEach(() => vi.unstubAllGlobals());

describe("bounded meeting history API", () => {
  it("reads distinct current and published pins without any history bodies", async () => {
    const published = versionFixture({ decision: "approved", published_at: "2026-10-10T01:00:00Z" });
    const current = versionFixture({ id: "new-version", version_number: 35 });
    const summary = workflowSummaryFixture(workflowFixture({ revision: 90, current_version_id: current.id, published_version_id: published.id, versions: [current, published] }));
    const fetch = show(summary);
    const signal = new AbortController().signal;
    expect(await client().getCockpitMeetingWorkflowSummary(WS, MEETING, signal)).toEqual(summary);
    expect(fetch).toHaveBeenCalledWith(`https://example.test/api/cockpit/meetings/${MEETING}/workflow/summary`, expect.objectContaining({ signal }));
    expect(summary.current_version).not.toHaveProperty("content");
    expect(summary.published_version).not.toHaveProperty("feedback");
  });

  it("distinguishes unenabled state from malformed or mismatched scope", async () => {
    const empty = workflowSummaryFixture(workflowFixture({ enabled: false, revision: 0, minutes_issue: null, reviewer_id: null }));
    show(empty);
    expect(await client().getCockpitMeetingWorkflowSummary(WS, MEETING)).toMatchObject({ enabled: false });
    for (const broken of [{ ...empty, workspace_id: "other" }, { ...empty, meeting_id: "other" }, { ...empty, history_counts: {} },
      { ...empty, representation: "full" }, { ...empty, current_version_id: "missing" }]) {
      show(broken); expect(await client().getCockpitMeetingWorkflowSummary(WS, MEETING)).toBeNull();
    }
  });

  it("keeps page bounds, counts, cursor and meeting scope honest", async () => {
    const version = versionMetadataFixture(versionFixture());
    const fetch = show({ ...page([version]), total: 35, next_cursor: "opaque+next" });
    const signal = new AbortController().signal;
    expect(await client().getCockpitMinutesVersions(WS, MEETING, { page_size: 1, cursor: "older+page" }, signal)).toMatchObject({ total: 35, next_cursor: "opaque+next" });
    expect(fetch.mock.calls[0]?.[0]).toContain("page_size=1&cursor=older%2Bpage");
    expect(fetch.mock.calls[0]?.[1].signal).toBe(signal);
    for (const broken of [{ ...page([version]), workspace_id: "foreign" }, { ...page([version]), meeting_id: "foreign" },
      page([version, version]), { ...page([version]), total: 0 }, { ...page([version]), next_cursor: undefined },
      { ...page([version]), workflow_revision: -1 }]) {
      show(broken); expect(await client().getCockpitMinutesVersions(WS, MEETING, { page_size: 1 })).toBeNull();
    }
  });

  it("reads one exact historical body and never substitutes another version", async () => {
    const version = versionFixture({ content: "A fixed old document", feedback: "The old review explanation" });
    const detail = { ...page(), version, can_review: false, can_publish: false, can_export_nas: false };
    const fetch = show(detail);
    expect(await client().getCockpitMinutesVersion(WS, MEETING, version.id)).toMatchObject({ version });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(`https://example.test/api/cockpit/meetings/${MEETING}/workflow/versions/${version.id}`);
    show({ ...detail, version: { ...version, id: "unrelated" } });
    expect(await client().getCockpitMinutesVersion(WS, MEETING, version.id)).toBeNull();
  });

  it("checks handoff and NAS history scopes and echoes filters", async () => {
    const handoff = { ...handoffFixture(), version_number: 1 };
    show(page([handoff]));
    expect(await client().getCockpitReviewerHandoffs(WS, MEETING)).toMatchObject({ items: [handoff] });
    show({ ...page([handoff]), meeting_id: "another" });
    expect(await client().getCockpitReviewerHandoffs(WS, MEETING)).toBeNull();
    const job = { ...nasExportFixture(), source_version: versionMetadataFixture(versionFixture({ decision: "approved", published_at: "2026-10-10T01:00:00Z" })) };
    const reply = { ...page([job]), version_id: job.version_id, status: "active" };
    show(reply);
    expect(await client().getCockpitNasExports(WS, MEETING, { version_id: job.version_id, status: "active" })).toMatchObject({ items: [job] });
    show({ ...reply, status: "succeeded" });
    expect(await client().getCockpitNasExports(WS, MEETING, { version_id: job.version_id, status: "active" })).toBeNull();
  });

  it("accepts an old submission receipt after newer versions, but rejects another key or document", async () => {
    const version = versionFixture();
    const latest = versionFixture({ id: "latest", version_number: 35, submission_key: "20000000-0000-4000-8000-000000000035" });
    const summary = workflowSummaryFixture(workflowFixture({ revision: 90, current_version_id: latest.id, versions: [latest] }));
    const reply = compactFixture(summary, { action: "submitted", version });
    const body = { expected_revision: 1, submission_key: WORKFLOW_SUBMISSION_KEY, content: "  Fixed minutes text\n" };
    const command = { action: "submitted" as const, body };
    const fetch = show(reply);
    await expect(client().commandCockpitMeetingWorkflow(WS, MEETING, command)).resolves.toMatchObject({ workflow: { current_version_id: "latest" }, receipt: { version } });
    expect(fetch.mock.calls[0]?.[0]).toBe(`https://example.test/api/cockpit/meetings/${MEETING}/workflow/versions?response=compact`);
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ ...body, content: "Fixed minutes text" });
    for (const mismatch of [{ ...version, submission_key: "wrong" }, { ...version, content: "Different document" }]) {
      show(compactFixture(summary, { action: "submitted", version: mismatch }));
      await expect(client().commandCockpitMeetingWorkflow(WS, MEETING, command)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
  });

  it("rejects legacy full responses and cross-scope compact success", async () => {
    const summary = workflowSummaryFixture();
    const command = { action: "enabled" as const, body: { reviewer_id: "reviewer-1" } };
    for (const broken of [workflowFixture(), { ...compactFixture(summary, { action: "enabled" }), workspace_id: "foreign" },
      compactFixture({ ...summary, meeting_id: "other" }, { action: "enabled" }), compactFixture(summary, { action: "readiness" })]) {
      show(broken); await expect(client().commandCockpitMeetingWorkflow(WS, MEETING, command)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
  });

  it("confirms an old handoff by its receipt instead of the current reviewer", async () => {
    const handoff = { ...handoffFixture(), version_number: 1 };
    const version = versionFixture({ reviewer_id: "reviewer-3", review_issue: { ...handoff.to_review_issue!, id: "review-3", assignee_id: "reviewer-3" } });
    const summary = workflowSummaryFixture(workflowFixture({ reviewer_id: "reviewer-3", revision: 90, current_version_id: version.id, versions: [version] }));
    const command = { action: "reviewer_reassigned" as const, body: { expected_revision: 1, handoff_key: WORKFLOW_HANDOFF_KEY, reviewer_id: "reviewer-2", reason: handoff.reason } };
    show(compactFixture(summary, { action: command.action, handoff, version }));
    await expect(client().commandCockpitMeetingWorkflow(WS, MEETING, command)).resolves.toMatchObject({ workflow: { reviewer_id: "reviewer-3" } });
    show(compactFixture(summary, { action: command.action, handoff: { ...handoff, handoff_key: "wrong" }, version }));
    await expect(client().commandCockpitMeetingWorkflow(WS, MEETING, command)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
  });
});
