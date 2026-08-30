"use client";

// Data composition for the Agent Office page (`/{ws}/office`).
//
// The office deliberately rides the same caches every other agent surface
// uses — presence map + agent list + task snapshot — and adds exactly two
// fetches of its own: the squad list and the 7-day usage-by-agent rollup
// (the token leaderboard). WebSocket task events keep presence and the
// snapshot fresh exactly as they do on the agents list.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { agentListOptions, squadListOptions } from "../workspace/queries";
import { agentTaskSnapshotOptions } from "../agents/queries";
import { useWorkspacePresenceMap } from "../agents/use-agent-presence";
import type { AgentPresenceDetail } from "../agents/types";
import { assignOfficeZones, type OfficeSquadInput } from "./zones";
import { buildChatter, buildOfficeTimeline, type ChatterAgentFacts } from "./timeline";
import type {
  OfficeChatter,
  OfficeFloorPlan,
  OfficeTimelineEntry,
  OfficeTokenRow,
} from "./types";
import type { Agent, AgentTask, Squad } from "../types";

/** How often idle agents rotate between the lounge / tea corner / canteen. */
export const OFFICE_PHASE_MS = 30_000;

/** Timeline rail length — enough to fill the column without scrolling far. */
const TIMELINE_LIMIT = 12;

/** Leaderboard size. The board shows the top consumers, not everyone. */
const TOKEN_BOARD_LIMIT = 8;

export interface OfficeScene {
  agents: Agent[];
  floor: OfficeFloorPlan;
  timeline: OfficeTimelineEntry[];
  chatter: OfficeChatter | null;
  tokenBoard: OfficeTokenRow[];
}

function squadInputs(squads: readonly Squad[], agentIds: Set<string>): OfficeSquadInput[] {
  const out: OfficeSquadInput[] = [];
  for (const s of squads) {
    // Archived squads keep their room off the floor plan.
    if (s.archived_at !== null) continue;
    const members = (s.member_preview ?? [])
      .filter((m) => m.member_type === "agent" && agentIds.has(m.member_id))
      .map((m) => m.member_id);
    if (members.length === 0) continue;
    out.push({ squadId: s.id, squadName: s.name, memberAgentIds: members, leaderAgentId: s.leader_id });
  }
  return out;
}

function groupTasksByAgent(tasks: readonly AgentTask[]): Map<string, AgentTask[]> {
  const map = new Map<string, AgentTask[]>();
  for (const t of tasks) {
    const list = map.get(t.agent_id);
    if (list) list.push(t);
    else map.set(t.agent_id, [t]);
  }
  return map;
}

function chatterFacts(
  agents: readonly Agent[],
  tasksByAgent: ReadonlyMap<string, readonly AgentTask[]>,
): ChatterAgentFacts[] {
  return agents.map((a) => {
    let runningCount = 0;
    let completedCount = 0;
    let failedCount = 0;
    for (const t of tasksByAgent.get(a.id) ?? []) {
      if (t.status === "running") runningCount += 1;
      else if (t.status === "completed") completedCount += 1;
      else if (t.status === "failed") failedCount += 1;
    }
    return { agentId: a.id, runningCount, completedCount, failedCount };
  });
}

export interface UsageByAgentRow {
  agent_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  task_count: number;
}

/** Merge per-(agent, model) usage rows into one leaderboard per agent. */
export function mergeTokenRows(
  rows: readonly UsageByAgentRow[],
  limit: number,
): OfficeTokenRow[] {
  const byAgent = new Map<string, OfficeTokenRow>();
  for (const r of rows) {
    // Empty agent_id rows cannot be attributed to a seat — drop them.
    if (r.agent_id === "") continue;
    const total =
      (r.input_tokens || 0) +
      (r.output_tokens || 0) +
      (r.cache_read_tokens || 0) +
      (r.cache_write_tokens || 0);
    if (total <= 0 && (r.task_count || 0) <= 0) continue;
    const cur = byAgent.get(r.agent_id);
    if (cur) {
      cur.totalTokens += total;
      cur.taskCount += r.task_count || 0;
    } else {
      byAgent.set(r.agent_id, {
        agentId: r.agent_id,
        totalTokens: total,
        taskCount: r.task_count || 0,
      });
    }
  }
  return [...byAgent.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, limit);
}

/**
 * Whole-office composition. `phase` comes from the caller's wall-clock tick
 * (views/office) so the hook itself stays render-pure and testable.
 */
export function useOfficeScene(wsId: string | undefined, phase: number): {
  scene: OfficeScene;
  /** Presence per agent — the page uses it to pick monologue slots. */
  presence: ReadonlyMap<string, AgentPresenceDetail>;
  loading: boolean;
} {
  const { byAgent, loading: presenceLoading } = useWorkspacePresenceMap(wsId);
  const { data: agents, isPending: agentsPending } = useQuery({
    ...agentListOptions(wsId ?? ""),
    enabled: !!wsId,
  });
  const { data: snapshot = [], isPending: snapshotPending } = useQuery({
    ...agentTaskSnapshotOptions(wsId ?? ""),
    enabled: !!wsId,
  });
  const { data: squads = [] } = useQuery(squadListOptions(wsId ?? ""));
  const { data: usage = [] } = useQuery({
    queryKey: ["workspaces", wsId ?? "", "office", "usage-by-agent", "7d"],
    queryFn: () => api.getDashboardUsageByAgent({ days: 7 }),
    enabled: !!wsId,
    staleTime: 5 * 60_000,
  });

  const scene = useMemo<OfficeScene>(() => {
    const agentList = agents ?? [];
    const agentIds = new Set(agentList.map((a) => a.id));
    const tasksByAgent = groupTasksByAgent(snapshot);
    const floor = assignOfficeZones({
      agents: agentList,
      presence: byAgent,
      squads: squadInputs(squads, agentIds),
      tasksByAgent,
      phase,
    });
    const timeline = buildOfficeTimeline(snapshot, TIMELINE_LIMIT);
    const chatter = buildChatter(
      chatterFacts(agentList, tasksByAgent),
      agentList.map((a) => a.id),
      phase,
    );
    const tokenBoard = mergeTokenRows(usage, TOKEN_BOARD_LIMIT);
    return { agents: agentList, floor, timeline, chatter, tokenBoard };
  }, [agents, snapshot, squads, usage, byAgent, phase]);

  return {
    scene,
    presence: byAgent,
    loading:
      presenceLoading || (agentsPending && !!wsId) || (snapshotPending && !!wsId),
  };
}
