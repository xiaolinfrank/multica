// @vitest-environment node
// Canonical matrix for the office floor-plan derivation. The component suite
// (packages/views/office) keeps only happy-path wiring; every zone rule and
// determinism property is pinned here.
import { describe, expect, it } from "vitest";
import type { Agent, AgentTask } from "../types";
import type { AgentPresenceDetail } from "../agents/types";
import { assignOfficeZones, MONOLOGUE_VARIANTS, pickMonologueSlot } from "./zones";
import { RELAX_ZONES, type OfficeZoneId } from "./types";

const agent = (id: string, extra: Partial<Agent> = {}): Agent =>
  ({ id, archived_at: null, runtime_bound: true, ...extra } as unknown as Agent);

const presence = (
  availability: AgentPresenceDetail["availability"],
  workload: AgentPresenceDetail["workload"],
  extra: Partial<AgentPresenceDetail> = {},
): AgentPresenceDetail => ({
  availability,
  workload,
  runningCount: workload === "working" ? 1 : 0,
  queuedCount: workload === "queued" ? 1 : 0,
  capacity: 3,
  ...extra,
});

const task = (id: string, agentId: string, status: AgentTask["status"], startedAt: string | null): AgentTask =>
  ({
    id,
    agent_id: agentId,
    status,
    started_at: startedAt,
    issue_id: "issue-1",
  } as unknown as AgentTask);

function allZones(floor: ReturnType<typeof assignOfficeZones>): ReadonlyMap<string, OfficeZoneId> {
  return floor.zoneByAgent;
}

describe("assignOfficeZones", () => {
  it("seats working agents at desks with their task counts", () => {
    const floor = assignOfficeZones({
      agents: [agent("a1")],
      presence: new Map([["a1", presence("online", "working", { runningCount: 2 })]]),
      squads: [],
      tasksByAgent: new Map([["a1", [task("t1", "a1", "running", "2026-01-01T00:00:02Z"), task("t2", "a1", "running", "2026-01-01T00:00:01Z")]]]),
      phase: 0,
    });
    expect(floor.desks).toHaveLength(1);
    expect(floor.desks[0]).toMatchObject({ agentId: "a1", runningCount: 2, capacity: 3, focusTaskId: "t1" });
    expect(allZones(floor).get("a1")).toBe("desk");
  });

  it("sends queued agents to the waiting corner, not a desk", () => {
    const floor = assignOfficeZones({
      agents: [agent("a1")],
      presence: new Map([["a1", presence("online", "queued")]]),
      squads: [],
      tasksByAgent: new Map(),
      phase: 0,
    });
    expect(floor.waiting).toEqual(["a1"]);
    expect(floor.desks).toHaveLength(0);
  });

  it("marks offline, unstable and unbound agents absent with the right reason", () => {
    const floor = assignOfficeZones({
      agents: [
        agent("off", { runtime_bound: true }),
        agent("uns", { runtime_bound: true }),
        agent("unb", { runtime_bound: false }),
      ],
      presence: new Map([
        ["off", presence("offline", "idle")],
        ["uns", presence("unstable", "idle")],
        // unbound agents read offline on presence; unbound must win.
        ["unb", presence("offline", "idle")],
      ]),
      squads: [],
      tasksByAgent: new Map(),
      phase: 0,
    });
    // Absent agents keep the input order; unbound outranks availability
    // only in the reason, not in position.
    expect(floor.absent.map((a) => [a.agentId, a.reason])).toEqual([
      ["off", "offline"],
      ["uns", "unstable"],
      ["unb", "unbound"],
    ]);
  });

  it("drops archived agents from the floor entirely", () => {
    const floor = assignOfficeZones({
      agents: [agent("gone", { archived_at: "2026-01-01T00:00:00Z" })],
      presence: new Map([["gone", presence("online", "working")]]),
      squads: [],
      tasksByAgent: new Map(),
      phase: 0,
    });
    expect(allZones(floor).has("gone")).toBe(false);
    expect(floor.desks).toHaveLength(0);
  });

  it("seats idle members of an active squad in its meeting room and lists working members as supporting", () => {
    const floor = assignOfficeZones({
      agents: [agent("w1"), agent("i1"), agent("i2")],
      presence: new Map([
        ["w1", presence("online", "working")],
        ["i1", presence("online", "idle")],
        ["i2", presence("online", "idle")],
      ]),
      squads: [{ squadId: "s1", squadName: "Core", memberAgentIds: ["w1", "i1", "i2"] }],
      tasksByAgent: new Map(),
      phase: 0,
    });
    expect(floor.meetings).toHaveLength(1);
    expect(floor.meetings[0]).toMatchObject({ squadId: "s1", attendeeAgentIds: ["i1", "i2"], supportingAgentIds: ["w1"] });
    expect(allZones(floor).get("i1")).toBe("meeting");
  });

  it("leaves squads without running work without a room", () => {
    const floor = assignOfficeZones({
      agents: [agent("i1")],
      presence: new Map([["i1", presence("online", "idle")]]),
      squads: [{ squadId: "s1", squadName: "Idle squad", memberAgentIds: ["i1"] }],
      tasksByAgent: new Map(),
      phase: 0,
    });
    expect(floor.meetings).toHaveLength(0);
    expect(allZones(floor).get("i1")).not.toBe("meeting");
  });

  it("rotates idle agents across relax zones as the phase advances", () => {
    const agents = Array.from({ length: 12 }, (_, i) => agent(`a${i}`));
    const presenceMap = new Map(agents.map((a) => [a.id, presence("online", "idle")]));
    const base = assignOfficeZones({ agents, presence: presenceMap, squads: [], tasksByAgent: new Map(), phase: 0 });
    const next = assignOfficeZones({ agents, presence: presenceMap, squads: [], tasksByAgent: new Map(), phase: 1 });
    // With 12 agents over 3 zones, at least someone must have moved.
    const moved = agents.filter((a) => allZones(base).get(a.id) !== allZones(next).get(a.id));
    expect(moved.length).toBeGreaterThan(0);
    // ...and both plans must still cover every agent exactly once.
    for (const floor of [base, next]) {
      const seated = [
        ...floor.desks.map((d) => d.agentId),
        ...floor.meetings.flatMap((m) => m.attendeeAgentIds),
        ...floor.waiting,
        ...floor.lounge,
        ...floor.tea,
        ...floor.canteen,
        ...floor.absent.map((a) => a.agentId),
      ];
      expect(seated).toHaveLength(agents.length);
      expect(new Set(seated).size).toBe(agents.length);
    }
  });

  it("is deterministic for identical inputs and phase", () => {
    const run = () =>
      assignOfficeZones({
        agents: [agent("a1"), agent("a2")],
        presence: new Map([
          ["a1", presence("online", "idle")],
          ["a2", presence("online", "idle")],
        ]),
        squads: [],
        tasksByAgent: new Map(),
        phase: 42,
      });
    expect(run()).toEqual(run());
  });
});

describe("pickMonologueSlot", () => {
  it("maps every zone to a slot kind within its variant budget", () => {
    const zones: OfficeZoneId[] = ["desk", "meeting", "waiting", "lounge", "tea", "canteen", "absent"];
    const presenceMap = new Map<string, AgentPresenceDetail>([
      ["x", presence("online", "working", { runningCount: 2, queuedCount: 3 })],
      ["y", presence("online", "queued", { queuedCount: 3 })],
      ["z", presence("offline", "idle")],
    ]);
    for (const zone of zones) {
      for (const agentId of ["x", "y", "z"]) {
        const slot = pickMonologueSlot(agentId, zone, presenceMap, 7);
        expect(slot.variant).toBeLessThan(MONOLOGUE_VARIANTS[slot.kind]);
      }
    }
    expect(pickMonologueSlot("x", "desk", presenceMap, 0).kind).toBe("working");
    expect(pickMonologueSlot("y", "waiting", presenceMap, 0).kind).toBe("waiting");
    expect(pickMonologueSlot("z", "absent", presenceMap, 0).kind).toBe("offline");
  });
});

describe("RELAX_ZONES", () => {
  it("lists exactly the three leisure zones", () => {
    expect([...RELAX_ZONES]).toEqual(["lounge", "tea", "canteen"]);
  });
});
