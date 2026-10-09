// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { CockpitUnconfirmedWriteError } from "../cockpit/errors";
import { actionFixture, actionPageFixture, actionTaskFixture, taskPageFixture, CREATION_KEY, DECISION_KEY, PROPOSAL_KEY } from "../cockpit/action-test-fixtures";

const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

describe("action and primary task boundaries", () => {
  it("sends server pagination/filter scope and rejects malformed, wrong-scope or unbounded pages", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(respond(taskPageFixture()))
      .mockResolvedValueOnce(respond({ node_id: "node-1", items: [] }))
      .mockResolvedValueOnce(respond(taskPageFixture({ node_id: "other-node" })))
      .mockResolvedValueOnce(respond(taskPageFixture({ items: Array.from({ length: 26 }, (_, index) => actionTaskFixture({ id: `issue-${index}` })) })))
      .mockResolvedValueOnce(respond(actionPageFixture()))
      .mockResolvedValueOnce(respond({ meeting_id: "meeting-1", items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("https://example.test");
    await expect(client.getCockpitNodeTasks("node-1", { q: "needle", category: "active", relation: "primary", cursor: "opaque-next", page_size: 25 })).resolves.toMatchObject({ node_id: "node-1" });
    const url = new URL(fetchMock.mock.calls[0]![0]);
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "needle", category: "active", relation: "primary", cursor: "opaque-next", page_size: "25" });
    for (let i = 0; i < 3; i++) await expect(client.getCockpitNodeTasks("node-1")).resolves.toBeNull();
    await expect(client.listCockpitMeetingActions("meeting-1", { status: "draft", cursor: "page-two", page_size: 25 })).resolves.toMatchObject({ total: 1 });
    await expect(client.listCockpitMeetingActions("meeting-1")).resolves.toBeNull();
  });

  it("preserves the original source excerpt and acknowledges suggestions by their stable proposal key", async () => {
    const quote = "  Verify interface.\n";
    const body = { proposal_key: PROPOSAL_KEY, title: "Verify interface", description: "Check all required fields.", source_quote: quote };
    const fetchMock = vi.fn().mockResolvedValueOnce(respond(actionFixture({ source_quote: quote })))
      .mockResolvedValueOnce(respond(actionFixture({ proposal_key: DECISION_KEY })));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("https://example.test");
    await expect(client.createCockpitMeetingAction("meeting-1", "version-1", body)).resolves.toMatchObject({ source_quote: quote });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).source_quote).toBe(quote);
    await expect(client.createCockpitMeetingAction("meeting-1", "version-1", body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
  });

  it("confirms only the intended action decision, without confusing live issue state with the immutable decision", async () => {
    const action = actionFixture();
    const confirmed = actionFixture({ status: "accepted", resolution: "reuse", decision_key: DECISION_KEY, revision: 2, node_id: "node-1",
      issue: actionTaskFixture({ status: "done", primary_node_id: "later-explicitly-moved-node" }), resolved_by: "member-1", resolved_at: "2026-10-10T11:00:00Z" });
    const fetchMock = vi.fn().mockResolvedValueOnce(respond(confirmed))
      .mockResolvedValueOnce(respond({ ...confirmed, decision_key: CREATION_KEY }))
      .mockResolvedValueOnce(respond({ ...confirmed, source_content_hash: "another-version" }))
      .mockResolvedValueOnce(respond({ ...confirmed, issue: null }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("https://example.test");
    const body = { expected_revision: 1, decision_key: DECISION_KEY, outcome: "reuse" as const, node_id: "node-1", issue_id: "issue-1" };
    await expect(client.resolveCockpitMeetingAction(action, body)).resolves.toMatchObject({ issue: { status: "done", primary_node_id: "later-explicitly-moved-node" } });
    for (let i = 0; i < 3; i++) await expect(client.resolveCockpitMeetingAction(action, body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
  });

  it("requires a real dismissed decision and reason rather than accepting HTTP success with a draft", async () => {
    const action = actionFixture();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(respond(action)).mockResolvedValueOnce(respond(actionFixture({
      status: "dismissed", resolution: "dismiss", revision: 2, decision_key: DECISION_KEY, reason: "Outside agreed scope", resolved_by: "member-1", resolved_at: "2026-10-10T11:00:00Z",
    }))));
    const client = new ApiClient("https://example.test");
    const body = { expected_revision: 1, decision_key: DECISION_KEY, outcome: "dismiss" as const, reason: "Outside agreed scope" };
    await expect(client.resolveCockpitMeetingAction(action, body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    await expect(client.resolveCockpitMeetingAction(action, body)).resolves.toMatchObject({ status: "dismissed", issue: null });
  });

  it("recovers a created issue by creation key after explicit ownership and title changes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(respond(actionTaskFixture({ creation_key: CREATION_KEY, primary_node_id: "moved-node", title: "Renamed issue", status: "done" })))
      .mockResolvedValueOnce(respond(actionTaskFixture())));
    const client = new ApiClient("https://example.test");
    const body = { creation_key: CREATION_KEY, title: "Original title" };
    await expect(client.createCockpitNodeTask("node-1", body)).resolves.toMatchObject({ title: "Renamed issue", primary_node_id: "moved-node" });
    await expect(client.createCockpitNodeTask("node-1", body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
  });

  it("checks primary ownership acknowledgment and the issue scope of paged action sources", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(respond({ issue_id: "other-issue", node_id: "node-1", revision: 1 }))
      .mockResolvedValueOnce(respond({ issue_id: "other-issue", items: [], total: 0, next_cursor: null }))
      .mockResolvedValueOnce(respond({ issue_id: "issue-1", items: [], total: 0, next_cursor: null })));
    const client = new ApiClient("https://example.test");
    await expect(client.setCockpitPrimaryNode("issue-1", { node_id: "node-1", expected_revision: 0 })).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    await expect(client.getCockpitIssueActionSources("issue-1")).resolves.toBeNull();
    await expect(client.getCockpitIssueActionSources("issue-1")).resolves.toEqual({ issue_id: "issue-1", items: [], total: 0, next_cursor: null });
  });
});
