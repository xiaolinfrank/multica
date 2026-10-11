// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cockpitIssueInputManifestPath } from "./input-view-navigation";
describe("exact issue manifest navigation", () => {
  it("opens a historical manifest and closes without discarding the issue context", () => {
    const context = new URLSearchParams("comment=comment-1&input_manifest=old");
    expect(cockpitIssueInputManifestPath("/ws/issues/PMO-1", context, "fixed-version")).toBe("/ws/issues/PMO-1?comment=comment-1&input_manifest=fixed-version");
    expect(cockpitIssueInputManifestPath("/ws/issues/PMO-1", context, null)).toBe("/ws/issues/PMO-1?comment=comment-1");
    expect(context.get("input_manifest")).toBe("old");
  });
});
