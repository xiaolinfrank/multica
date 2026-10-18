// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CockpitAttentionTarget } from "../types/cockpit-overview";
import { cockpitAttentionDestination } from "./dashboard-model";

const target = (patch: Partial<CockpitAttentionTarget>): CockpitAttentionTarget => ({ kind: "", id: "", meeting_id: null, version_id: null, node_id: null, issue_id: null, action_id: null, export_id: null, ...patch });

describe("dashboard attention destinations", () => {
  it("maps each known business target to its existing surface", () => {
    expect(cockpitAttentionDestination(target({ kind: "issue", id: "issue-1", issue_id: "issue-1", node_id: "node-1" }))).toEqual({ kind: "issue", id: "issue-1" });
    expect(cockpitAttentionDestination(target({ kind: "node", id: "node-1", node_id: "node-1" }))).toEqual({ kind: "node", id: "node-1" });
    expect(cockpitAttentionDestination(target({ kind: "meeting", id: "meeting-1", meeting_id: "meeting-1", version_id: "version-1", export_id: "export-1", issue_id: "minutes-1" })))
      .toEqual({ kind: "meeting", id: "meeting-1" });
    expect(cockpitAttentionDestination(target({ kind: "action", id: "action-1", action_id: "action-1", meeting_id: "meeting-1", version_id: "version-1" })))
      .toEqual({ kind: "meeting", id: "meeting-1", actionId: "action-1" });
  });

  it.each(["issue", "node", "meeting", "action"] as const)("refuses conflicting identity for a %s target", (kind) => {
    const canonical = { issue: "issue_id", node: "node_id", meeting: "meeting_id", action: "action_id" } as const;
    expect(cockpitAttentionDestination(target({ kind, id: "first", meeting_id: "meeting-1", [canonical[kind]]: "other" }))).toBeNull();
  });

  it("requires an action's meeting and never converts future or missing targets into homepage navigation", () => {
    expect(cockpitAttentionDestination(target({ kind: "action", id: "action-1", action_id: "action-1" }))).toBeNull();
    expect(cockpitAttentionDestination(target({ kind: "action", meeting_id: "meeting-1" }))).toBeNull();
    expect(cockpitAttentionDestination(target({ kind: "future", id: "issue-1", issue_id: "issue-1" }))).toBeNull();
    expect(cockpitAttentionDestination(target({ kind: "issue" }))).toBeNull();
  });

  it("supports one explicit identity without interpreting its value as a route", () => {
    expect(cockpitAttentionDestination(target({ kind: "issue", issue_id: "issue-1" }))).toEqual({ kind: "issue", id: "issue-1" });
    expect(cockpitAttentionDestination(target({ kind: "meeting", id: "meeting-1" }))).toEqual({ kind: "meeting", id: "meeting-1" });
    expect(cockpitAttentionDestination(target({ kind: "action", action_id: "action-1", meeting_id: "meeting-1" }))).toEqual({ kind: "meeting", id: "meeting-1", actionId: "action-1" });
  });
});
