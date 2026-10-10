// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseWithFallback } from "./schema";
import { CockpitArtifactHeaderSchema, CockpitArtifactPageSchema, CockpitArtifactVersionCommandResponseSchema, CockpitArtifactVersionDetailSchema, CockpitArtifactVersionMetadataSchema, CockpitAcceptanceRequestDetailSchema } from "./cockpit-artifact-schemas";
import { artifactFixture, artifactVersionDetailFixture, artifactVersionFixture, acceptanceFixture } from "../cockpit/artifact-test-fixtures";

const parsePage = (raw: unknown) => parseWithFallback(raw, CockpitArtifactPageSchema, null, { endpoint: "GET /api/cockpit/artifacts" });
const scope = { project_id: null, module_id: null, node_id: null, source_issue_id: null, q: "", status: "", relation: "owned", ids: [] };

describe("artifact and acceptance response contracts", () => {
  it("accepts a bounded empty result while rejecting false zeroes and oversized pages", () => {
    const empty = { workspace_id: "ws-1", scope, items: [], total: 0, filtered_total: 0, next_cursor: null, can_create: true };
    expect(parsePage(empty)).toEqual(empty);
    for (const raw of [{ ...empty, total: -1 }, { ...empty, items: [artifactFixture()] }, { ...empty, total: 200, filtered_total: 200, items: Array.from({ length: 101 }, () => artifactFixture()) }]) {
      expect(parsePage(raw)).toBeNull();
    }
  });

  it("keeps unknown states visible with missing capabilities disabled", () => {
    const version = artifactVersionFixture({ capture_status: "future-store-state", decision: "future-review-state", can_review: undefined });
    const parsed = CockpitArtifactVersionMetadataSchema.parse(version);
    expect(parsed.capture_status).toBe("future-store-state");
    expect(parsed.decision).toBe("future-review-state");
    expect(parsed.can_review).toBe(false);
  });

  it("refuses formal approval before payload freezing or without a human review issue", () => {
    expect(CockpitArtifactVersionMetadataSchema.safeParse(artifactVersionFixture({ decision: "approved", capture_status: "running", content_hash: null })).success).toBe(false);
    expect(CockpitArtifactVersionMetadataSchema.safeParse(artifactVersionFixture({ decision: "approved", review_issue: null })).success).toBe(false);
    expect(CockpitArtifactVersionMetadataSchema.safeParse(artifactVersionFixture({ capture_status: "ready", content_hash: null })).success).toBe(false);
  });

  it("preserves the designated reviewer's ability to return unavailable content without inventing a usable download", () => {
    const version = artifactVersionFixture({ payload_kind: "attachment", source_attachment_id: "file-1" });
    const detail = artifactVersionDetailFixture({ version, content: null, content_available: false, content_unavailable_reason: "object_missing" });
    expect(CockpitArtifactVersionDetailSchema.parse(detail).version.can_review).toBe(true);
    expect(CockpitArtifactVersionDetailSchema.safeParse({ ...detail, download_url: "https://storage.example.test/invalid" }).success).toBe(false);
    const request = acceptanceFixture({ evidence_available: false, evidence_unavailable_reason: "object_missing", definition_changed: true });
    expect(CockpitAcceptanceRequestDetailSchema.parse(request).request.can_review).toBe(true);
  });

  it("does not substitute a newly approved version for the version explicitly referenced as evidence", () => {
    const approved = artifactVersionFixture({ decision: "approved", can_review: false });
    expect(CockpitArtifactHeaderSchema.safeParse(artifactFixture({ approved_version: approved, evidence_version: approved })).success).toBe(true);
    expect(CockpitArtifactHeaderSchema.safeParse(artifactFixture({ approved_version: { ...approved, id: "version-2", version_number: 2 }, evidence_version: approved })).success).toBe(false);
    expect(CockpitArtifactHeaderSchema.safeParse(artifactFixture({ approved_version: approved, evidence_version: null })).success).toBe(true);
  });

  it("requires command receipts and pins to remain inside their workspace and artifact", () => {
    const result = { workspace_id: "ws-1", artifact: artifactFixture(), version: artifactVersionDetailFixture() };
    expect(CockpitArtifactVersionCommandResponseSchema.safeParse(result).success).toBe(true);
    expect(CockpitArtifactVersionCommandResponseSchema.safeParse({ ...result, workspace_id: "other" }).success).toBe(false);
    expect(CockpitArtifactVersionCommandResponseSchema.safeParse({ ...result, artifact: artifactFixture({ current_version: artifactVersionFixture({ artifact_id: "other" }) }) }).success).toBe(false);
    expect(CockpitArtifactVersionCommandResponseSchema.safeParse({ ...result, version: artifactVersionDetailFixture({ artifact_id: "other" }) }).success).toBe(false);
  });

  it("rejects duplicate or unapproved acceptance evidence instead of presenting a complete snapshot", () => {
    const result = acceptanceFixture();
    expect(CockpitAcceptanceRequestDetailSchema.safeParse(result).success).toBe(true);
    expect(CockpitAcceptanceRequestDetailSchema.safeParse({ ...result, evidence: [...result.evidence, ...result.evidence] }).success).toBe(false);
    expect(CockpitAcceptanceRequestDetailSchema.safeParse({ ...result, evidence: [{ ...result.evidence[0], versions: [artifactVersionFixture()] }] }).success).toBe(false);
    expect(CockpitAcceptanceRequestDetailSchema.safeParse({ ...result, node_id: "other" }).success).toBe(false);
  });
});
