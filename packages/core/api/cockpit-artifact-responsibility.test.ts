// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { artifactFixture, artifactVersionFixture, ARTIFACT_CREATION_KEY } from "../cockpit/artifact-test-fixtures";
import { CockpitArtifactHandoffResponseSchema } from "./cockpit-artifact-responsibility-schemas";
import { CockpitIssueArtifactContextPageSchema } from "./cockpit-issue-artifact-schemas";

function reply(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return { client: new ApiClient("https://example.test"), fetchMock };
}
afterEach(() => vi.unstubAllGlobals());
const time = "2026-10-11T00:00:00Z";
const assignment = { id: "assignment-1", artifact_id: "artifact-1", command_key: ARTIFACT_CREATION_KEY, from_issue_id: "source-1", to_issue_id: "producer-2", reason: "Continue revision", created_by: "author-1", created_at: time, revision: 3,
  from_issue_identifier: "", from_issue_title: "", to_issue_identifier: "", to_issue_title: "", created_by_name: "" };
const reference = { id: "reference-1", artifact_id: "artifact-1", version_id: "version-1", version_number: 1, content_hash: "a".repeat(64), reference_key: ARTIFACT_CREATION_KEY,
  node_id: "target-node", target_label: "Target", purpose: "evidence", created_by: "author-1", created_at: time, removed_by: null, removed_at: null };

describe("artifact responsibility response boundaries", () => {
  it("reads a meeting's explicit fixed references without treating removed references as active material", async () => {
    const { node_id: _nodeId, ...fields } = reference;
    const item = { ...fields, meeting_id: "meeting-1", artifact_title: "Delivery report" };
    const body = { workspace_id: "ws-1", meeting_id: "meeting-1", include_removed: false, items: [item], total: 1, next_cursor: null };
    await expect(reply(body).client.getCockpitMeetingArtifactReferences("ws-1", "meeting-1")).resolves.toEqual(body);
    const removed = { ...item, removed_by: "author-1", removed_at: time };
    await expect(reply({ ...body, items: [removed] }).client.getCockpitMeetingArtifactReferences("ws-1", "meeting-1")).resolves.toBeNull();
    const history = { ...body, include_removed: true, items: [removed] };
    await expect(reply(history).client.getCockpitMeetingArtifactReferences("ws-1", "meeting-1", { include_removed: true })).resolves.toEqual(history);
    await expect(reply(body).client.getCockpitMeetingArtifactReferences("ws-1", "meeting-2")).resolves.toBeNull();
  });
  it("reads an original producer receipt even after another handoff, but rejects wrong ledger targets", async () => {
    const artifact = artifactFixture();
    const body = { workspace_id: "ws-1", artifact, assignment, to_issue: { ...artifact.producer_issue, id: "producer-2" } };
    const command = { command_key: ARTIFACT_CREATION_KEY, expected_revision: 2, issue_id: "producer-2", reason: "Continue revision" };
    await expect(reply(body).client.assignCockpitArtifactProducer("ws-1", "artifact-1", command)).resolves.toEqual(body);
    for (const wrong of [{ ...body, workspace_id: "other" }, { ...body, to_issue: artifact.producer_issue }, { ...body, assignment: { ...assignment, from_issue_id: "producer-2" } }]) {
      await expect(reply(wrong).client.assignCockpitArtifactProducer("ws-1", "artifact-1", command)).resolves.toBeNull();
    }
  });

  it("allows a reviewer handoff during capture without inventing review issues", () => {
    const version = artifactVersionFixture({ capture_status: "running", decision: "not_requested", content_hash: null, size_bytes: null, review_issue: null });
    const body = { workspace_id: "ws-1", artifact: artifactFixture({ current_version: version }), version,
      handoff: { id: "handoff-1", artifact_id: "artifact-1", handoff_key: ARTIFACT_CREATION_KEY, from_reviewer_id: "old", to_reviewer_id: "new",
        version_id: "version-1", version_number: 1, from_review_issue_id: null, to_review_issue_id: null, reason: "Cover leave", created_by: "author-1", created_at: time, revision: 3 } };
    expect(CockpitArtifactHandoffResponseSchema.safeParse(body).success).toBe(true);
    expect(CockpitArtifactHandoffResponseSchema.safeParse({ ...body, handoff: { ...body.handoff, to_review_issue_id: "new-review" } }).success).toBe(false);
    expect(CockpitArtifactHandoffResponseSchema.safeParse({ ...body, version: null }).success).toBe(false);
  });

  it("keeps reference history scoped and rejects repeated cursors and crossed target kinds", async () => {
    const body = { workspace_id: "ws-1", artifact_id: "artifact-1", items: [reference], total: 1, next_cursor: null };
    const { client, fetchMock } = reply(body);
    await expect(client.getCockpitArtifactReferences("ws-1", "artifact-1", "node")).resolves.toEqual(body);
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get("X-Workspace-ID")).toBe("ws-1");
    await expect(reply(body).client.getCockpitArtifactReferences("ws-1", "artifact-1", "meeting")).resolves.toBeNull();
    await expect(reply({ ...body, next_cursor: "same" }).client.getCockpitArtifactReferences("ws-1", "artifact-1", "node", { cursor: "same" })).resolves.toBeNull();
    await expect(reply({ ...body, items: [{ ...reference, meeting_id: "meeting-1" }] }).client.getCockpitArtifactReferences("ws-1", "artifact-1", "node")).resolves.toBeNull();
    const removed = { workspace_id: "ws-1", reference: { ...reference, removed_by: "author-1", removed_at: time } };
    await expect(reply(removed).client.createCockpitArtifactReference("ws-1", "artifact-1", "node", { node_id: "target-node", version_id: "version-1", reference_key: ARTIFACT_CREATION_KEY, purpose: "evidence" })).resolves.toEqual(removed);
  });
});

describe("Issue reverse artifact context", () => {
  const item = { kind: "artifact_version", id: "version-1", roles: ["version_producer", "retired_review"], artifact_id: "artifact-1", artifact_title: "Report", version_id: "version-1", version_number: 1,
    node_id: "node-1", node_label: "Delivery", request_id: null, decision: "pending", reviewer_id: "reviewer-1", is_current_review: false };
  const page = { workspace_id: "ws-1", issue_id: "issue-1", formal_review: null, items: [item], total: 1, next_cursor: null };

  it("loads a bounded exact Issue and rejects corrupt identities instead of showing false provenance", async () => {
    const { client, fetchMock } = reply(page);
    await expect(client.getCockpitIssueArtifacts("ws-1", "issue-1")).resolves.toEqual(page);
    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get("page_size")).toBe("25");
    await expect(reply(page).client.getCockpitIssueArtifacts("ws-1", "issue-other")).resolves.toBeNull();
    for (const patch of [{ id: "wrong" }, { artifact_id: null }, { request_id: "mixed" }, { version_number: null }, { roles: ["review", "review"] }]) {
      expect(CockpitIssueArtifactContextPageSchema.safeParse({ ...page, items: [{ ...item, ...patch }] }).success).toBe(false);
    }
  });

  it("retains unfamiliar future roles and kinds without guessing formal authority", () => {
    const body = { ...page, items: [{ ...item, kind: "future-kind", roles: ["future-role"] }] };
    expect(CockpitIssueArtifactContextPageSchema.parse(body)).toEqual(body);
  });
});
