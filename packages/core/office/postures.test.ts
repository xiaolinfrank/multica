// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assignPoses, FLOOR_SEATS } from "./postures";
import type { OfficeFloorPlan } from "./types";

const plan = (over: Partial<OfficeFloorPlan>): OfficeFloorPlan => ({
  desks: [],
  meetings: [],
  lounge: [],
  tea: [],
  canteen: [],
  gym: [],
  waiting: [],
  absent: [],
  zoneByAgent: new Map(),
  ...over,
});

describe("assignPoses", () => {
  it("seats up to eight desk workers and stands the overflow behind", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `d${i}`);
    const poses = assignPoses(plan({ desks: ids.map((id) => ({ agentId: id, runningCount: 1, capacity: 2, focusTaskId: null })) }), 0);
    expect(poses.filter((p) => p.posture === "sitting")).toHaveLength(FLOOR_SEATS.desk);
    expect(poses.filter((p) => p.posture === "standing")).toHaveLength(2);
    expect(poses.every((p) => p.zone === "desk")).toBe(true);
  });

  it("caps each squad room at six chairs and keeps squads independent", () => {
    const poses = assignPoses(
      plan({
        meetings: [
          { squadId: "s1", squadName: "One", attendeeAgentIds: ["m0", "m1"], supportingAgentIds: [] },
          { squadId: "s2", squadName: "Two", attendeeAgentIds: Array.from({ length: 7 }, (_, i) => `m${i + 2}`), supportingAgentIds: [] },
        ],
      }),
      0,
    );
    // Squad One brings two attendees (both seated), Squad Two six of seven.
    expect(poses.filter((p) => p.posture === "sitting")).toHaveLength(2 + FLOOR_SEATS.meetingPerSquad);
    expect(poses.filter((p) => p.posture === "standing")).toHaveLength(1);
  });

  it("lets exactly one stroller wander a leisure room once three or more relax there", () => {
    const ids = ["a", "b", "c"];
    for (const phase of [0, 1, 2]) {
      const poses = assignPoses(plan({ lounge: ids, tea: [], canteen: [] }), phase);
      const walkers = poses.filter((p) => p.posture === "walking");
      expect(walkers).toHaveLength(1);
      expect(walkers[0]!.agentId).toBe(ids[phase % 3]!);
      expect(poses.filter((p) => p.posture === "sitting")).toHaveLength(2);
    }
  });

  it("keeps quiet rooms fully seated with nobody strolling", () => {
    const poses = assignPoses(plan({ tea: ["x", "y"], canteen: ["z"] }), 7);
    expect(poses.filter((p) => p.posture === "walking")).toHaveLength(0);
    expect(poses.every((p) => p.posture === "sitting")).toBe(true);
  });

  it("seats two on the gym bench and jogs the third once three relax there", () => {
    const ids = ["g0", "g1", "g2"];
    for (const phase of [0, 1, 2]) {
      const poses = assignPoses(plan({ gym: ids }), phase);
      expect(poses.filter((p) => p.posture === "sitting")).toHaveLength(FLOOR_SEATS.gym);
      const joggers = poses.filter((p) => p.posture === "walking");
      expect(joggers).toHaveLength(1);
      expect(joggers[0]!.agentId).toBe(ids[phase % 3]!);
      expect(poses.every((p) => p.zone === "gym")).toBe(true);
    }
  });

  it("never yields a posture for absent agents", () => {
    const poses = assignPoses(
      plan({ desks: [{ agentId: "on", runningCount: 0, capacity: 1, focusTaskId: null }], absent: [{ agentId: "off", reason: "offline" }] }),
      0,
    );
    expect(poses.map((p) => p.agentId)).toEqual(["on"]);
  });

  it("seats the waiting bench and stands only once it overflows", () => {
    const ids = Array.from({ length: 5 }, (_, i) => `w${i}`);
    const poses = assignPoses(plan({ waiting: ids }), 0);
    expect(poses.filter((p) => p.posture === "sitting")).toHaveLength(FLOOR_SEATS.waiting);
    expect(poses.filter((p) => p.posture === "standing")).toHaveLength(1);
  });
});
