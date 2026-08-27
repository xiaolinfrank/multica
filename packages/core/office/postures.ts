// Posture planning for the isometric floor. Zone assignment decides WHICH
// room an agent is in; this module decides what they are DOING there —
// sitting at a chair, standing behind the last row, or strolling across the
// room. Grid coordinates stay in the views layer; only the decision matrix
// lives here so the node suite can pin it down.
import type { OfficeFloorPlan, OfficeZoneId } from "./types";

export type OfficePosture = "sitting" | "standing" | "walking";

export interface AgentPose {
  agentId: string;
  zone: Exclude<OfficeZoneId, "absent">;
  posture: OfficePosture;
}

/**
 * Physical seats drawn on the isometric floor. Must match the seat tables
 * rendered by views/office — keep the numbers in sync with office-floor.tsx.
 */
export const FLOOR_SEATS = {
  desk: 8,
  meetingPerSquad: 6,
  lounge: 4,
  tea: 3,
  canteen: 6,
  waiting: 4,
} as const;

export function assignPoses(floor: OfficeFloorPlan, phase: number): AgentPose[] {
  const out: AgentPose[] = [];

  // Desks: every working agent sits at their own station until the eight
  // drawn desks run out, then the overflow stands behind the back row.
  floor.desks.forEach((d, i) => {
    out.push({
      agentId: d.agentId,
      zone: "desk",
      posture: i < FLOOR_SEATS.desk ? "sitting" : "standing",
    });
  });

  // Squad rooms: six chairs around the table per squad, extras stand.
  for (const m of floor.meetings) {
    m.attendeeAgentIds.forEach((id, i) => {
      out.push({
        agentId: id,
        zone: "meeting",
        posture: i < FLOOR_SEATS.meetingPerSquad ? "sitting" : "standing",
      });
    });
  }

  // Leisure rooms: with three or more present, exactly one of them strolls
  // around the room — they yield their seat, so the rest keep chairs.
  // The stroller rotates with the phase so seating reshuffles every window.
  for (const zone of ["lounge", "tea", "canteen"] as const) {
    const ids = floor[zone];
    const walkerAt = ids.length >= 3 ? ((phase % ids.length) + ids.length) % ids.length : -1;
    let sitting = 0;
    ids.forEach((id, i) => {
      if (i === walkerAt) {
        out.push({ agentId: id, zone, posture: "walking" });
        return;
      }
      out.push({
        agentId: id,
        zone,
        posture: sitting < FLOOR_SEATS[zone] ? "sitting" : "standing",
      });
      sitting += 1;
    });
  }

  // Waiting corner: everyone parks on the bench, standing once it fills.
  floor.waiting.forEach((id, i) => {
    out.push({
      agentId: id,
      zone: "waiting",
      posture: i < FLOOR_SEATS.waiting ? "sitting" : "standing",
    });
  });

  return out;
}
