// @vitest-environment node
import { expect, it } from "vitest";
import { cockpitFormalReviewAllowsStatus } from "./issue-formal-review";
import { CockpitIssueArtifactContextPageSchema } from "../api/cockpit-issue-artifact-schemas";
import type { CockpitIssueFormalReview } from "../types";

const review: CockpitIssueFormalReview = { kind: "artifact_version", stage: "pending", node_id: "node-1", artifact_id: "artifact-1", version_id: "version-1", request_id: null };

it("keeps formal review restrictions independent of a page containing only unrelated origins", () => {
  const page = CockpitIssueArtifactContextPageSchema.parse({ workspace_id: "ws-1", issue_id: "issue-1", formal_review: review, items: [], total: 400, next_cursor: "next" });
  expect(page.formal_review).toEqual(review);
  for (const category of ["triage", "backlog", "unstarted", "started"]) expect(cockpitFormalReviewAllowsStatus(page.formal_review, category)).toBe(true);
  for (const category of ["done", "closed", "unknown"]) expect(cockpitFormalReviewAllowsStatus(page.formal_review, category)).toBe(false);
});

it("keeps decided and retired reviews in their formal terminal category", () => {
  expect(cockpitFormalReviewAllowsStatus({ ...review, stage: "done" }, "done")).toBe(true);
  expect(cockpitFormalReviewAllowsStatus({ ...review, stage: "closed" }, "closed")).toBe(true);
  for (const stage of ["done", "closed", "future"]) expect(cockpitFormalReviewAllowsStatus({ ...review, stage }, "started")).toBe(false);
  expect(cockpitFormalReviewAllowsStatus(null, "done")).toBe(true);
});
