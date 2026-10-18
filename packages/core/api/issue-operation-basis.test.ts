// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { operationBasisFixture, operationBasisPageFixture } from "../issues/operation-basis-test-fixtures";
import { IssueOperationBasisPageSchema } from "./issue-operation-basis-schemas";

function reply(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return { client: new ApiClient("https://example.test"), fetchMock };
}
afterEach(() => vi.unstubAllGlobals());

describe("issue operation basis read boundary", () => {
  it("binds the initiating workspace and requires the complete requested set in order", async () => {
    const page = operationBasisPageFixture(["issue-1", "issue-2"]);
    const { client, fetchMock } = reply(page);
    await expect(client.getIssueOperationBasis("ws-1", ["issue-1", "issue-2", "issue-1"])).resolves.toEqual(page);
    expect(fetchMock.mock.calls[0]![1].headers["X-Workspace-ID"]).toBe("ws-1");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ issue_ids: ["issue-1", "issue-2"] });
    for (const invalid of [
      { ...page, workspace_id: "other" }, { ...page, items: page.items.slice(0, 1) },
      { ...page, items: [...page.items].reverse() }, { ...page, items: [page.items[0], page.items[0]] },
      { ...page, schema_version: 2 }, { ...page, items: [] },
    ]) await expect(reply(invalid).client.getIssueOperationBasis("ws-1", ["issue-1", "issue-2"])).resolves.toBeNull();
  });
  it("bounds a single request before network access instead of silently dropping IDs", async () => {
    const { client, fetchMock } = reply({});
    for (const ids of [[], [""], Array.from({ length: 101 }, (_, i) => "issue-" + i)]) {
      await expect(client.getIssueOperationBasis("ws-1", ids)).rejects.toThrow(RangeError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not interpret unknown field state or a missing field as permission", () => {
    const page = operationBasisPageFixture(["issue-1"]);
    expect(IssueOperationBasisPageSchema.parse({ ...page, items: [{ ...page.items[0], assignee: { state: "future", reason_codes: [] } }] }).items[0]!.assignee.state).toBe("unknown");
    for (const patch of [{ scope: undefined }, { status: { state: "allowed" } }, { targets_total: -1 }]) {
      expect(IssueOperationBasisPageSchema.safeParse({ ...page, items: [{ ...page.items[0], ...patch }] }).success).toBe(false);
    }
  });
  it("keeps unavailable objects opaque and requires real target identities", () => {
    const unknown = { state: "unknown" as const, reason_codes: ["basis_unavailable"] };
    const unavailable = operationBasisFixture("outside", { availability: "unavailable", issue_revision: null,
      status: { ...unknown, allowed_categories: [] }, assignee: unknown, scope: unknown, parent: unknown,
      primary: unknown, delete: unknown, execution: unknown });
    const page = { ...operationBasisPageFixture(["outside"]), items: [unavailable] };
    expect(IssueOperationBasisPageSchema.safeParse(page).success).toBe(true);
    expect(IssueOperationBasisPageSchema.safeParse({ ...page, items: [{ ...unavailable, targets: [{ kind: "issue", issue_id: "outside", label: "Hidden title", purpose: "history" }], targets_total: 1 }] }).success).toBe(false);
    const brokenTarget = { kind: "artifact_version", artifact_id: "a1", label: "Report", purpose: "formal_review" };
    expect(IssueOperationBasisPageSchema.safeParse({ ...page, items: [operationBasisFixture("issue-1", { targets: [brokenTarget], targets_total: 1 })] }).success).toBe(false);
    const draftTarget = { kind: "artifact", artifact_id: "a1", label: "Draft report", purpose: "artifact_source" };
    expect(IssueOperationBasisPageSchema.safeParse({ ...page, items: [operationBasisFixture("issue-1", { targets: [draftTarget], targets_total: 1 })] }).success).toBe(true);
    expect(IssueOperationBasisPageSchema.safeParse({ ...page, items: [operationBasisFixture("issue-1", { targets: [{ ...draftTarget, artifact_id: undefined }], targets_total: 1 })] }).success).toBe(false);
  });
  it("checks container kind and identity, including the cockpit node endpoint", async () => {
    const field = { state: "blocked", reason_codes: ["retained_formal_history"] };
    const basis = { workspace_id: "ws-1", schema_version: 1, generated_at: "2026-10-11T00:00:00Z", resource_kind: "node", resource_id: "node-1",
      availability: "available", resource_revision: null, delete: field, structural_edit: field, add_child: field, targets: [], targets_total: 0 };
    const { client, fetchMock } = reply(basis);
    await expect(client.getContainerOperationBasis("ws-1", "node", "node-1")).resolves.toEqual(basis);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://example.test/api/cockpit/nodes/node-1/operation-basis");
    await expect(reply(basis).client.getContainerOperationBasis("ws-1", "module", "node-1")).resolves.toBeNull();
    await expect(reply(basis).client.getContainerOperationBasis("ws-1", "node", "other")).resolves.toBeNull();
  });
});
