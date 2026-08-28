// Recent-activity rail + tea-corner chatter for the Agent Office page.
//
// Both builders read only the workspace agent-task snapshot — the same cache
// presence derives from — so the office adds zero network traffic beyond the
// squad list and the 7-day usage rollup. Chatter lines are structured slots:
// the views layer supplies the words (see #7411 for why translated packages
// must not carry labels).

import type { AgentTask } from "../types";
import { hashString, MONOLOGUE_VARIANTS } from "./zones";
import type { MonologueSlot, OfficeChatter, OfficeTimelineEntry } from "./types";

/** Latest meaningful timestamp of a task, in priority order. */
function taskStamp(t: AgentTask): string {
  return t.completed_at ?? t.started_at ?? t.dispatched_at ?? t.created_at ?? "";
}

/**
 * Newest-first activity entries from active + terminal snapshot tasks.
 * `limit` caps the rail; callers typically pass 12.
 */
export function buildOfficeTimeline(
  tasks: readonly AgentTask[],
  limit: number,
): OfficeTimelineEntry[] {
  const entries: OfficeTimelineEntry[] = [];
  for (const t of tasks) {
    let kind: OfficeTimelineEntry["kind"];
    switch (t.status) {
      case "running":
        kind = "running";
        break;
      case "completed":
        kind = "completed";
        break;
      case "failed":
        kind = "failed";
        break;
      default:
        // queued / dispatched / waiting_local_directory / cancelled are not
        // rail-worthy: the rail narrates work done and work in flight.
        continue;
    }
    entries.push({
      taskId: t.id,
      agentId: t.agent_id,
      issueId: t.issue_id,
      kind,
      at: taskStamp(t),
    });
  }
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return entries.slice(0, limit);
}

export interface ChatterAgentFacts {
  agentId: string;
  /** Running task count right now (0 when idle). */
  runningCount: number;
  /** Tasks completed within the snapshot window. */
  completedCount: number;
  failedCount: number;
}

function chatterSlot(f: ChatterAgentFacts, phase: number): MonologueSlot {
  if (f.runningCount > 0) {
    return {
      kind: "working",
      variant: (hashString(`${f.agentId}:chatter-working`) + phase) % MONOLOGUE_VARIANTS.working,
      runningCount: f.runningCount,
    };
  }
  if (f.completedCount > 0) {
    return {
      kind: "completed",
      variant: (hashString(`${f.agentId}:chatter-done`) + phase) % MONOLOGUE_VARIANTS.completed,
      count: f.completedCount,
    };
  }
  if (f.failedCount > 0) {
    return {
      kind: "failed",
      variant: (hashString(`${f.agentId}:chatter-fail`) + phase) % MONOLOGUE_VARIANTS.failed,
    };
  }
  return {
    kind: "idle",
    variant: (hashString(`${f.agentId}:chatter-idle`) + phase) % MONOLOGUE_VARIANTS.idle,
    zone: "tea",
  };
}

/**
 * One tea-corner exchange between two agents with something to say: pickers
 * prefer agents with running work or fresh completions so the small talk
 * stays grounded in real activity. Falls back to the first two idle agents;
 * returns null only when fewer than two agents exist at all.
 */
export function buildChatter(
  facts: readonly ChatterAgentFacts[],
  agentIds: readonly string[],
  phase: number,
): OfficeChatter | null {
  if (agentIds.length < 2) return null;
  const byId = new Map(facts.map((f) => [f.agentId, f]));
  const score = (id: string): number => {
    const f = byId.get(id);
    if (!f) return 0;
    return f.runningCount * 3 + f.completedCount * 2 + f.failedCount;
  };
  const ranked = [...agentIds].sort((a, b) => score(b) - score(a));
  const a = ranked[0];
  if (!a) return null;
  let b = ranked[1];
  // Keep the pair stable within a phase but rotate the second speaker.
  if (ranked.length > 2) {
    b = ranked[1 + (hashString(a) + phase) % (ranked.length - 1)] ?? b;
  }
  if (!b || a === b) b = ranked.find((id) => id !== a) ?? b;
  if (!b || a === b) return null;

  const fa = byId.get(a);
  const fb = byId.get(b);
  return {
    aAgentId: a,
    bAgentId: b,
    lines: [
      { speakerAgentId: a, slot: chatterSlot(fa ?? { agentId: a, runningCount: 0, completedCount: 0, failedCount: 0 }, phase) },
      { speakerAgentId: b, slot: chatterSlot(fb ?? { agentId: b, runningCount: 0, completedCount: 0, failedCount: 0 }, phase) },
      { speakerAgentId: a, slot: chatterSlot(fa ?? { agentId: a, runningCount: 0, completedCount: 0, failedCount: 0 }, phase) },
    ],
  };
}
