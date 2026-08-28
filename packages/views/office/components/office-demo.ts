import type { Agent, AgentTask } from "@multica/core/types";
import type { OfficeScene } from "@multica/core/office";
import type { AgentPresenceDetail } from "@multica/core/agents";
import {
  assignOfficeZones,
  buildChatter,
  buildOfficeTimeline,
  mergeTokenRows,
} from "@multica/core/office";
import type { OfficeMemberFigure } from "./office-users";

// A fully-staffed synthetic office for visual development and screenshot
// verification (`/{ws}/office?demo=1`). It reuses the real pure builders
// (zones / timeline / chatter / token rollup), so the demo exercises the
// exact rendering pipeline production data goes through — only the raw
// inputs are canned. No server calls happen in demo mode.

export interface DemoScene {
  scene: OfficeScene;
  presence: ReadonlyMap<string, AgentPresenceDetail>;
  /** Stand-in humans for the members corner; the first is "you". */
  users: OfficeMemberFigure[];
}

const agent = (id: string, name: string): Agent =>
  ({
    id,
    name,
    avatar_url: null,
    archived_at: null,
    runtime_bound: true,
    max_concurrent_tasks: 4,
  }) as unknown as Agent;

const task = (
  id: string,
  agentId: string,
  status: AgentTask["status"],
  startedAt: string,
): AgentTask =>
  ({ id, agent_id: agentId, status, issue_id: `i-${id}`, started_at: startedAt }) as unknown as AgentTask;

export function buildDemoScene(phase: number): DemoScene {
  const agents = [
    agent("demo-mika", "Mika"),
    agent("demo-alpha", "Alpha"),
    agent("demo-gamma", "Gamma"),
    agent("demo-beta", "Beta"),
    agent("demo-delta", "Delta"),
    agent("demo-eps", "Epsilon"),
    agent("demo-zeta", "Zeta"),
    agent("demo-eta", "Eta"),
    agent("demo-theta", "Theta"),
    agent("demo-iota", "Iota"),
  ];

  const presence = new Map<string, AgentPresenceDetail>([
    ["demo-mika", { availability: "online", workload: "working", runningCount: 2, queuedCount: 0, capacity: 4 }],
    ["demo-alpha", { availability: "online", workload: "working", runningCount: 1, queuedCount: 0, capacity: 3 }],
    ["demo-gamma", { availability: "online", workload: "queued", runningCount: 0, queuedCount: 2, capacity: 3 }],
    ["demo-beta", { availability: "online", workload: "idle", runningCount: 0, queuedCount: 0, capacity: 2 }],
    ["demo-delta", { availability: "online", workload: "idle", runningCount: 0, queuedCount: 0, capacity: 2 }],
    ["demo-eps", { availability: "online", workload: "idle", runningCount: 0, queuedCount: 0, capacity: 2 }],
    ["demo-zeta", { availability: "online", workload: "idle", runningCount: 0, queuedCount: 0, capacity: 2 }],
    ["demo-eta", { availability: "online", workload: "idle", runningCount: 0, queuedCount: 0, capacity: 2 }],
    ["demo-theta", { availability: "offline", workload: "idle", runningCount: 0, queuedCount: 0, capacity: 2 }],
    ["demo-iota", { availability: "unstable", workload: "idle", runningCount: 0, queuedCount: 0, capacity: 2 }],
  ]);

  const tasks: AgentTask[] = [
    task("t1", "demo-mika", "running", "2026-08-27T08:02:00Z"),
    task("t2", "demo-mika", "running", "2026-08-27T06:40:00Z"),
    task("t3", "demo-alpha", "running", "2026-08-27T07:15:00Z"),
    task("t4", "demo-alpha", "completed", "2026-08-27T05:30:00Z"),
    task("t5", "demo-beta", "completed", "2026-08-27T04:10:00Z"),
    task("t6", "demo-zeta", "failed", "2026-08-27T03:45:00Z"),
    task("t7", "demo-mika", "completed", "2026-08-26T21:12:00Z"),
  ];

  const floor = assignOfficeZones({
    agents,
    presence,
    squads: [
      {
        squadId: "sq-demo",
        squadName: "Platform Crew",
        memberAgentIds: ["demo-zeta", "demo-eta"],
      },
    ],
    tasksByAgent: new Map([
      ["demo-mika", [tasks[0]!, tasks[1]!, tasks[6]!]],
      ["demo-alpha", [tasks[2]!, tasks[4] as AgentTask]],
      ["demo-zeta", [tasks[5] as AgentTask]],
      ["demo-beta", []],
    ]),
    phase,
  });

  const chatter = buildChatter(
    agents.map((a) => {
      const p = presence.get(a.id);
      return {
        agentId: a.id,
        runningCount: p?.workload === "working" ? Math.max(p.runningCount, 1) : 0,
        completedCount: a.id === "demo-beta" || a.id === "demo-alpha" ? 1 : 0,
        failedCount: a.id === "demo-zeta" ? 1 : 0,
      };
    }),
    agents.map((a) => a.id),
    phase,
  );

  const scene: OfficeScene = {
    agents,
    floor,
    timeline: buildOfficeTimeline(tasks, 12),
    chatter,
    tokenBoard: mergeTokenRows(
      [
        { agent_id: "demo-mika", input_tokens: 184000, output_tokens: 26000, cache_read_tokens: 410000, cache_write_tokens: 21000, task_count: 14 },
        { agent_id: "demo-alpha", input_tokens: 92000, output_tokens: 14000, cache_read_tokens: 205000, cache_write_tokens: 9000, task_count: 7 },
        { agent_id: "demo-zeta", input_tokens: 40000, output_tokens: 8000, cache_read_tokens: 88000, cache_write_tokens: 5000, task_count: 4 },
        { agent_id: "demo-beta", input_tokens: 12000, output_tokens: 2400, cache_read_tokens: 30000, cache_write_tokens: 1600, task_count: 2 },
        { agent_id: "demo-gamma", input_tokens: 3000, output_tokens: 400, cache_read_tokens: 8000, cache_write_tokens: 300, task_count: 1 },
      ],
      8,
    ),
  };

  return {
    scene,
    presence,
    users: [
      {
        userId: "demo-user-0",
        name: "You",
        email: "you@fosunpharma.com",
        avatarUrl: null,
        status: "🎧 focusing",
        isSelf: true,
      },
      {
        userId: "demo-user-1",
        name: "林医生",
        email: "lin@fosunpharma.com",
        avatarUrl: null,
        status: "🏋️ at the gym",
        isSelf: false,
      },
      {
        userId: "demo-user-2",
        name: "Wang",
        email: "wang@fosunpharma.com",
        avatarUrl: null,
        status: "",
        isSelf: false,
      },
    ],
  };
}
