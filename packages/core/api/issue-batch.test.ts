// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./client";
import { IssueBatchUnconfirmedError, parseIssueBatchReceipt } from "./issue-batch-schemas";
import { issueBatchAppliedIds, issueBatchComplete, issueBatchErrorReceipt } from "../issues/batch-receipt";

const ids = ["i1", "i2", "i3"];
const partial = { workspace_id: "ws-1", requested_ids: ids, transaction_mode: "per_item", transaction_outcome: "partial", updated: 1,
  results: [{ issue_id: "i1", outcome: "applied", revision: 4, changed: true },
    { issue_id: "i2", outcome: "rejected", code: "formal_review_required" },
    { issue_id: "i3", outcome: "not_attempted", code: "batch_stopped" }], unconfirmed_ids: [] };
function reply(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return { client: new ApiClient("https://example.test"), fetchMock };
}
afterEach(() => vi.unstubAllGlobals());

describe("batch result boundaries", () => {
  it("preserves a 409 and exposes only its scoped, complete partial receipt", async () => {
    const { client, fetchMock } = reply({ ...partial, error: "Formal review required", code: "formal_review_required" }, 409);
    let error: unknown;
    try { await client.batchUpdateIssues("ws-1", ids, { status: "done" }, { expected_revisions: { i1: 3 } }); }
    catch (cause) { error = cause; }
    expect(error).toBeInstanceOf(ApiError);
    const receipt = issueBatchErrorReceipt(error, "ws-1", ids, "update");
    expect(receipt).toMatchObject(partial);
    expect(receipt?.code).toBe("formal_review_required");
    expect(receipt?.error).toBe("Formal review required");
    expect(issueBatchAppliedIds(receipt)).toEqual(["i1"]);
    expect(issueBatchComplete(receipt)).toBe(false);
    expect(issueBatchErrorReceipt(error, "other", ids, "update")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1].headers["X-Workspace-ID"]).toBe("ws-1");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).expected_revisions).toEqual({ i1: 3 });
  });
  it("never calls a count-only or malformed acknowledgement a completed batch", async () => {
    for (const body of [{ updated: 3 }, { ...partial, updated: 2 }, { ...partial, results: partial.results.slice(0, 2) },
      { ...partial, results: [partial.results[0], partial.results[0], partial.results[2]] },
      { ...partial, transaction_outcome: "committed" }, { ...partial, workspace_id: "other" }]) {
      await expect(reply(body).client.batchUpdateIssues("ws-1", ids, { status: "done" })).rejects.toBeInstanceOf(IssueBatchUnconfirmedError);
    }
  });
  it("distinguishes confirmed rollback from a commit whose result is unknown", () => {
    const rolledBack = { ...partial, transaction_mode: "atomic", transaction_outcome: "rolled_back", updated: undefined, deleted: 0,
      results: ids.map((issue_id) => ({ issue_id, outcome: "not_applied", code: "batch_rolled_back" })) };
    const receipt = parseIssueBatchReceipt(rolledBack, "ws-1", ids, "delete");
    expect(receipt?.transaction_outcome).toBe("rolled_back");
    expect(issueBatchAppliedIds(receipt)).toEqual([]);
    const unknown = { ...rolledBack, transaction_outcome: "unknown", results: [], unconfirmed_ids: ids };
    expect(parseIssueBatchReceipt(unknown, "ws-1", ids, "delete")?.unconfirmed_ids).toEqual(ids);
    expect(parseIssueBatchReceipt({ ...unknown, transaction_outcome: "rolled_back" }, "ws-1", ids, "delete")).toBeNull();
    expect(issueBatchErrorReceipt(new Error("network interrupted"), "ws-1", ids, "delete")).toBeNull();
  });
  it("counts atomic deletion of the known subset without silently reporting missing IDs as deleted", async () => {
    const body = { ...partial, transaction_mode: "atomic", updated: undefined, deleted: 1,
      results: [{ issue_id: "i1", outcome: "applied" }, ...ids.slice(1).map((issue_id) => ({ issue_id, outcome: "rejected", code: "not_found" }))] };
    const receipt = await reply(body).client.batchDeleteIssues("ws-1", ids);
    expect(issueBatchAppliedIds(receipt)).toEqual(["i1"]);
    expect(issueBatchComplete(receipt)).toBe(false);
    const complete = { ...body, transaction_outcome: "committed", deleted: 3, results: ids.map((issue_id) => ({ issue_id, outcome: "applied" })) };
    expect(issueBatchComplete(await reply(complete).client.batchDeleteIssues("ws-1", ids))).toBe(true);
  });
  it("validates expected revisions before sending and scopes single-object deletions", async () => {
    const { client, fetchMock } = reply({});
    await expect(client.batchDeleteIssues("ws-1", ids, { expected_revisions: { other: 1 } })).rejects.toThrow(RangeError);
    await expect(client.batchUpdateIssues("ws-1", ids, { priority: "high" }, { expected_revisions: { i1: 0 } })).rejects.toThrow(RangeError);
    await expect(client.deleteIssue("", "i1")).rejects.toThrow(RangeError);
    await expect(client.deleteProject("", "p1")).rejects.toThrow(RangeError);
    await expect(client.deleteModule("ws-1", "")).rejects.toThrow(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
    await client.deleteIssue("ws-1", "i1");
    expect(fetchMock.mock.calls[0]![1].headers["X-Workspace-ID"]).toBe("ws-1");
  });
});
