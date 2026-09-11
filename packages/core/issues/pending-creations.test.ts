// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AgentTask } from "../types";
import {
  PENDING_CREATION_LINK_GRACE_MS,
  PENDING_CREATION_MAX_AGE_MS,
  derivePendingCreations,
} from "./pending-creations";

const NOW = Date.parse("2026-09-11T12:00:00.000Z");
const ME = "user-me";

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    agent_id: "agent-1",
    runtime_id: "runtime-1",
    issue_id: "",
    status: "queued",
    priority: 0,
    dispatched_at: null,
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    created_at: new Date(NOW - 5_000).toISOString(),
    kind: "quick_create",
    attribution: { source: "direct_human", precise: true, originator: { id: ME } },
    quick_create_prompt: "Draft the Q4 rollout plan",
    ...overrides,
  } as AgentTask;
}

function derive(
  tasks: AgentTask[],
  extra: {
    availability?: Map<string, string | undefined>;
    dismissed?: Set<string>;
    userId?: string | null;
    projectId?: string;
    now?: number;
  } = {},
) {
  return derivePendingCreations({
    tasks,
    userId: extra.userId === undefined ? ME : extra.userId,
    availability: extra.availability ?? new Map(),
    dismissed: extra.dismissed ?? new Set(),
    now: extra.now ?? NOW,
    projectId: extra.projectId,
  });
}

describe("derivePendingCreations", () => {
  it("reports a queued creation on an idle, reachable agent", () => {
    const [row] = derive([task()]);
    expect(row!.state).toBe("queued");
    expect(row!.taskId).toBe("task-1");
    expect(row!.prompt).toBe("Draft the Q4 rollout plan");
  });

  it("says a queued creation is behind its agent's current run, not merely queued", () => {
    // ClaimAgentTask serialises quick-creates per agent, so "queued" here means
    // "next in line", which reads very differently from "nothing is happening".
    const rows = derive([
      task({ id: "running", status: "running" }),
      task({ id: "waiting" }),
    ]);
    expect(rows.find((r) => r.taskId === "waiting")?.state).toBe("queued_behind");
    expect(rows.find((r) => r.taskId === "running")?.state).toBe("working");
  });

  it("says the agent is offline rather than leaving the row looking stalled", () => {
    const [row] = derive([task()], {
      availability: new Map([["agent-1", "offline"]]),
    });
    expect(row!.state).toBe("queued_offline");
  });

  it.each(["dispatched", "running", "waiting_local_directory"] as const)(
    "treats %s as work in progress",
    (status) => {
      expect(derive([task({ status })])[0]!.state).toBe("working");
    },
  );

  it("surfaces a failed creation with its reason", () => {
    const [row] = derive([
      task({ status: "failed", failure_reason: "agent_error.timeout" }),
    ]);
    expect(row!.state).toBe("failed");
    expect(row!.failureReason).toBe("agent_error.timeout");
  });

  it("retires a creation the moment its queue row gains an issue", () => {
    // The reconciliation gate: once `multica issue create` lands, the issue is
    // in the list on its own and a pending record would be a duplicate.
    expect(derive([task({ status: "completed", issue_id: "issue-9" })])).toEqual([]);
  });

  it("holds back 'nothing was created' while the completed row may still be linking", () => {
    // CompleteTask links the issue before broadcasting, and the broadcast
    // serialises the pre-link struct — so completed + empty issue_id is a
    // legitimate transient. Flashing a failure there would be a lie.
    const rows = derive([
      task({
        status: "completed",
        completed_at: new Date(NOW - (PENDING_CREATION_LINK_GRACE_MS - 1_000)).toISOString(),
      }),
    ]);
    expect(rows).toEqual([]);
  });

  it("reports a completed-but-issueless run once the link grace has passed", () => {
    const [row] = derive([
      task({
        status: "completed",
        completed_at: new Date(NOW - (PENDING_CREATION_LINK_GRACE_MS + 1_000)).toISOString(),
      }),
    ]);
    expect(row!.state).toBe("unconfirmed");
  });

  it("describes no status it does not understand", () => {
    // Server-driven enum. cancelled never reaches this endpoint at all, and a
    // status from a newer backend cannot be described truthfully.
    expect(derive([task({ status: "cancelled" })])).toEqual([]);
    expect(derive([task({ status: "quantum" as AgentTask["status"] })])).toEqual([]);
  });

  it("ignores task kinds that are not quick-creates", () => {
    expect(derive([task({ kind: "chat" })])).toEqual([]);
    expect(derive([task({ kind: "direct", issue_id: "issue-1" })])).toEqual([]);
  });

  it("shows only the creations this user asked for", () => {
    const rows = derive([
      task({ id: "mine" }),
      task({
        id: "theirs",
        attribution: { source: "direct_human", precise: true, originator: { id: "user-other" } },
      }),
    ]);
    expect(rows.map((r) => r.taskId)).toEqual(["mine"]);
  });

  it("drops dismissed rows", () => {
    expect(derive([task()], { dismissed: new Set(["task-1"]) })).toEqual([]);
  });

  it("stops showing a creation that has been pending for a day", () => {
    const rows = derive([
      task({
        created_at: new Date(NOW - (PENDING_CREATION_MAX_AGE_MS + 1_000)).toISOString(),
      }),
    ]);
    expect(rows).toEqual([]);
  });

  it("narrows to one project when the surface is a project", () => {
    const rows = derive(
      [
        task({ id: "here", project_id: "proj-a" }),
        task({ id: "elsewhere", project_id: "proj-b" }),
        task({ id: "no-project" }),
      ],
      { projectId: "proj-a" },
    );
    expect(rows.map((r) => r.taskId)).toEqual(["here"]);
  });

  it("returns nothing without a snapshot or a signed-in user", () => {
    expect(derive([], {})).toEqual([]);
    expect(
      derivePendingCreations({
        tasks: undefined,
        userId: ME,
        availability: new Map(),
        dismissed: new Set(),
        now: NOW,
      }),
    ).toEqual([]);
    expect(derive([task()], { userId: null })).toEqual([]);
  });

  it("orders the newest creation first", () => {
    const rows = derive([
      task({ id: "old", created_at: new Date(NOW - 60_000).toISOString() }),
      task({ id: "new", created_at: new Date(NOW - 1_000).toISOString() }),
      task({ id: "mid", created_at: new Date(NOW - 30_000).toISOString() }),
    ]);
    expect(rows.map((r) => r.taskId)).toEqual(["new", "mid", "old"]);
  });

  it("carries the retry routing signals through untouched", () => {
    const [row] = derive([
      task({
        status: "failed",
        quick_create_source_context_id: "ctx-7",
        squad_id: "squad-3",
        project_id: "proj-a",
      }),
    ]);
    expect(row!.sourceContextId).toBe("ctx-7");
    expect(row!.squadId).toBe("squad-3");
    expect(row!.projectId).toBe("proj-a");
  });

  it("degrades to an empty prompt when the backend does not project one", () => {
    const [row] = derive([task({ quick_create_prompt: undefined })]);
    expect(row!.prompt).toBe("");
    expect(row!.state).toBe("queued");
  });
});
