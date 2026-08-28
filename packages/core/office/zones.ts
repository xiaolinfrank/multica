// Pure zone assignment for the Agent Office floor plan (`/{ws}/office`).
//
// Mapping rules (one zone per non-archived agent, decided in this order):
//
//   1. unbound / offline / unstable runtime        → absent (door plaque)
//   2. workload "working"                          → desk
//   3. workload "queued"                           → waiting (printer corner)
//   4. idle + member of a squad with work in flight→ meeting (that squad's room)
//   5. idle otherwise                              → lounge / tea / canteen,
//      picked by hash(agent.id + phase) so the cast visibly "walks around"
//      every phase without any server-side state.
//
// Everything here is synchronous and side-effect free: the same inputs +
// phase always yield the same floor plan, which is what the unit tests pin.

import type { Agent, AgentTask } from "../types";
import type { AgentPresenceDetail } from "../agents/types";
import {
  RELAX_ZONES,
  type AbsentAssignment,
  type DeskAssignment,
  type MeetingAssignment,
  type MonologueSlot,
  type OfficeFloorPlan,
  type OfficeZoneId,
  type RelaxZone,
} from "./types";

/** FNV-1a 32-bit. Stable across sessions (unlike Math.random), cheap, and
 * enough entropy for seating a few dozen agents. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const ABSENT_PRESENCE: AgentPresenceDetail = {
  availability: "offline",
  workload: "idle",
  runningCount: 0,
  queuedCount: 0,
  capacity: 0,
};

export interface OfficeSquadInput {
  squadId: string;
  squadName: string;
  /** Member agent ids, already intersected with the workspace agent list. */
  memberAgentIds: readonly string[];
}

export interface AssignOfficeZonesInput {
  agents: readonly Agent[];
  presence: ReadonlyMap<string, AgentPresenceDetail>;
  squads: readonly OfficeSquadInput[];
  /** Active + latest-terminal tasks per agent, for the desk focus monitor. */
  tasksByAgent: ReadonlyMap<string, readonly AgentTask[]>;
  /** Seat-rotation counter; callers derive it from the wall clock. */
  phase: number;
}

/** Squads with at least one member currently working, keyed by squad id. */
function activeSquadIds(
  squads: readonly OfficeSquadInput[],
  presence: ReadonlyMap<string, AgentPresenceDetail>,
): Set<string> {
  const active = new Set<string>();
  for (const squad of squads) {
    for (const id of squad.memberAgentIds) {
      if (presence.get(id)?.workload === "working") {
        active.add(squad.squadId);
        break;
      }
    }
  }
  return active;
}

/** The most recently started running task — what the desk monitor shows. */
function focusTaskId(tasks: readonly AgentTask[] | undefined): string | null {
  if (!tasks) return null;
  let best: AgentTask | null = null;
  for (const t of tasks) {
    if (t.status !== "running") continue;
    if (
      best === null ||
      (t.started_at ?? "") > (best.started_at ?? "")
    ) {
      best = t;
    }
  }
  return best ? best.id : null;
}

export function assignOfficeZones(input: AssignOfficeZonesInput): OfficeFloorPlan {
  const { agents, presence, squads, tasksByAgent, phase } = input;
  const desks: DeskAssignment[] = [];
  const meetings: MeetingAssignment[] = [];
  const waiting: string[] = [];
  const relax: Record<RelaxZone, string[]> = { lounge: [], tea: [], canteen: [] };
  const absent: AbsentAssignment[] = [];
  const zoneByAgent = new Map<string, OfficeZoneId>();

  const activeSquads = activeSquadIds(squads, presence);
  // agent.id → first active squad they belong to. First match wins; an agent
  // in two active squads sits in whichever the iteration finds first.
  const meetingSquadByAgent = new Map<string, OfficeSquadInput>();
  for (const squad of squads) {
    if (!activeSquads.has(squad.squadId)) continue;
    for (const id of squad.memberAgentIds) {
      if (!meetingSquadByAgent.has(id)) meetingSquadByAgent.set(id, squad);
    }
  }

  for (const agent of agents) {
    // Archived agents left the company — they do not get a seat.
    if (agent.archived_at !== null) continue;
    const p = presence.get(agent.id) ?? ABSENT_PRESENCE;

    let zone: OfficeZoneId;
    if (agent.runtime_bound === false) {
      zone = "absent";
      absent.push({ agentId: agent.id, reason: "unbound" });
    } else if (p.availability === "offline" || p.availability === "unstable") {
      zone = "absent";
      absent.push({ agentId: agent.id, reason: p.availability });
    } else if (p.workload === "working") {
      zone = "desk";
      desks.push({
        agentId: agent.id,
        runningCount: p.runningCount,
        capacity: p.capacity,
        focusTaskId: focusTaskId(tasksByAgent.get(agent.id)),
      });
    } else if (p.workload === "queued") {
      zone = "waiting";
      waiting.push(agent.id);
    } else {
      const squad = meetingSquadByAgent.get(agent.id);
      if (squad) {
        zone = "meeting";
        let room = meetings.find((m) => m.squadId === squad.squadId);
        if (!room) {
          room = {
            squadId: squad.squadId,
            squadName: squad.squadName,
            attendeeAgentIds: [],
            supportingAgentIds: [],
          };
          meetings.push(room);
        }
        room.attendeeAgentIds.push(agent.id);
      } else {
        const seat = RELAX_ZONES[(hashString(agent.id) + phase) % RELAX_ZONES.length] ?? "lounge";
        zone = seat;
        relax[seat].push(agent.id);
      }
    }
    zoneByAgent.set(agent.id, zone);
  }

  // Second pass: squad members working at their desks are shown as
  // "supporting" in their squad's room so the room explains where they are.
  for (const squad of squads) {
    if (!activeSquads.has(squad.squadId)) continue;
    const room = meetings.find((m) => m.squadId === squad.squadId);
    if (!room) continue;
    for (const id of squad.memberAgentIds) {
      if (presence.get(id)?.workload === "working") {
        room.supportingAgentIds.push(id);
      }
    }
  }

  return {
    desks,
    meetings,
    waiting,
    lounge: relax.lounge,
    tea: relax.tea,
    canteen: relax.canteen,
    absent,
    zoneByAgent,
  };
}

/** Variant counts per monologue kind — the `office` locale bundle must carry
 * at least this many lines for each; see office.json `monologue.*`. */
export const MONOLOGUE_VARIANTS = {
  working: 4,
  queued: 3,
  idle: 3,
  meeting: 3,
  waiting: 3,
  completed: 3,
  failed: 2,
  offline: 2,
  unbound: 1,
} as const;

function variant(agentId: string, phase: number, kind: keyof typeof MONOLOGUE_VARIANTS): number {
  return (hashString(`${agentId}:${kind}`) + phase) % MONOLOGUE_VARIANTS[kind];
}

/** Structured monologue slot for an agent's current seat. Copy lives in the
 * views layer (`office` locale bundle); this only picks which line + params. */
export function pickMonologueSlot(
  agentId: string,
  zone: OfficeZoneId,
  presence: ReadonlyMap<string, AgentPresenceDetail>,
  phase: number,
): MonologueSlot {
  const p = presence.get(agentId);
  switch (zone) {
    case "desk":
      return {
        kind: "working",
        variant: variant(agentId, phase, "working"),
        runningCount: p?.runningCount ?? 1,
      };
    case "waiting":
      return {
        kind: "waiting",
        variant: variant(agentId, phase, "waiting"),
        queuedCount: p?.queuedCount ?? 1,
      };
    case "meeting":
      return { kind: "meeting", variant: variant(agentId, phase, "meeting") };
    case "lounge":
    case "tea":
    case "canteen":
      return {
        kind: "idle",
        variant: variant(agentId, phase, "idle"),
        zone,
      };
    case "absent": {
      // Unbound beats offline for the plaque, mirroring assignOfficeZones.
      return { kind: "offline", variant: variant(agentId, phase, "offline") };
    }
  }
}
