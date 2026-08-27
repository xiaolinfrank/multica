// @vitest-environment node
// Canonical matrix for the office timeline rail, chatter pairing and the
// token-leaderboard merge. Component tests keep only the wiring.
import { describe, expect, it } from "vitest";
import type { AgentTask } from "../types";
import { buildChatter, buildOfficeTimeline, type ChatterAgentFacts } from "./timeline";
import { mergeTokenRows } from "./use-office-scene";

const task = (
  id: string,
  agentId: string,
  status: AgentTask["status"],
  at: string,
): AgentTask =>
  ({
    id,
    agent_id: agentId,
    status,
    issue_id: `issue-${id}`,
    completed_at: status === "completed" || status === "failed" ? at : null,
    started_at: at,
    dispatched_at: at,
    created_at: at,
  } as unknown as AgentTask);

describe("buildOfficeTimeline", () => {
  it("keeps running/completed/failed, drops queued and cancelled, sorts newest first, honors the limit", () => {
    const entries = buildOfficeTimeline(
      [
        task("old", "a1", "completed", "2026-01-01T00:00:01Z"),
        task("new-run", "a2", "running", "2026-01-03T00:00:00Z"),
        task("skip-q", "a3", "queued", "2026-01-04T00:00:00Z"),
        task("skip-c", "a3", "cancelled", "2026-01-04T00:00:00Z"),
        task("fail", "a1", "failed", "2026-01-02T00:00:00Z"),
      ],
      2,
    );
    expect(entries.map((e) => e.taskId)).toEqual(["new-run", "fail"]);
    expect(entries[0]).toMatchObject({ agentId: "a2", kind: "running" });
    expect(entries[1]).toMatchObject({ agentId: "a1", kind: "failed" });
  });

  it("falls back through completed → started → dispatched → created stamps", () => {
    const entries = buildOfficeTimeline(
      [
        {
          id: "no-dates",
          agent_id: "a1",
          status: "running",
          issue_id: "",
          completed_at: null,
          started_at: null,
          dispatched_at: null,
          created_at: "2026-01-01T00:00:00Z",
        } as unknown as AgentTask,
      ],
      5,
    );
    expect(entries[0]!.at).toBe("2026-01-01T00:00:00Z");
  });
});

describe("buildChatter", () => {
  const facts = (id: string, running: number, done: number): ChatterAgentFacts => ({
    agentId: id,
    runningCount: running,
    completedCount: done,
    failedCount: 0,
  });

  it("returns null with fewer than two agents", () => {
    expect(buildChatter([facts("a1", 1, 0)], ["a1"], 0)).toBeNull();
  });

  it("picks two distinct speakers and prefers agents with activity", () => {
    const chatter = buildChatter(
      [facts("busy", 2, 0), facts("idle", 0, 0), facts("done", 0, 3)],
      ["busy", "idle", "done"],
      0,
    );
    expect(chatter).not.toBeNull();
    expect(chatter!.aAgentId).toBe("busy"); // running×3 outranks completed×2
    expect(chatter!.bAgentId).not.toBe(chatter!.aAgentId);
    expect(chatter!.lines).toHaveLength(3);
    expect(chatter!.lines[0]!.speakerAgentId).toBe(chatter!.aAgentId);
    expect(chatter!.lines[1]!.speakerAgentId).toBe(chatter!.bAgentId);
    expect(chatter!.lines[0]!.slot.kind).toBe("working");
    expect(chatter!.lines[1]!.slot.kind).toBe("completed");
  });

  it("is stable for the same phase", () => {
    const f = [facts("a1", 1, 0), facts("a2", 0, 0), facts("a3", 0, 0)];
    const ids = ["a1", "a2", "a3"];
    expect(buildChatter(f, ids, 5)).toEqual(buildChatter(f, ids, 5));
  });
});

describe("mergeTokenRows", () => {
  it("merges per-model rows per agent, sorts desc, drops empty ids and caps the board", () => {
    const rows = mergeTokenRows(
      [
        { agent_id: "a1", input_tokens: 100, output_tokens: 50, cache_read_tokens: 10, cache_write_tokens: 5, task_count: 2 },
        { agent_id: "a1", input_tokens: 200, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, task_count: 1 },
        { agent_id: "a2", input_tokens: 999, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, task_count: 5 },
        { agent_id: "", input_tokens: 5000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, task_count: 1 },
      ],
      8,
    );
    expect(rows).toEqual([
      { agentId: "a2", totalTokens: 999, taskCount: 5 },
      { agentId: "a1", totalTokens: 365, taskCount: 3 },
    ]);
  });

  it("keeps zero-token agents off the board", () => {
    expect(
      mergeTokenRows(
        [{ agent_id: "a1", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, task_count: 0 }],
        8,
      ),
    ).toEqual([]);
  });
});
