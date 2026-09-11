import type { AgentTask } from "../types";

/**
 * A quick-create whose issue does not exist yet, from the point of view of the
 * person who asked for it.
 *
 * Derived purely from the workspace agent-task snapshot. Two properties of that
 * endpoint bound what this can and cannot promise (see
 * ListWorkspaceAgentTaskSnapshot in server/pkg/db/queries/agent.sql):
 *   - Active rows (queued / dispatched / running / waiting_local_directory) are
 *     ALL returned, so in-flight coverage is complete. That is the reported bug.
 *   - Terminal rows are only each agent's single most recent completed/failed
 *     row, and cancelled rows are never returned. A failure therefore shows here
 *     opportunistically; the durable failure record is the inbox item the server
 *     writes. Do not present this as the failure feed.
 */
export type PendingCreationState =
  | "queued"
  | "queued_behind"
  | "queued_offline"
  | "working"
  | "failed"
  | "unconfirmed";

export interface PendingCreation {
  taskId: string;
  agentId: string;
  state: PendingCreationState;
  /** Empty when the backend predates the originator-gated projection. */
  prompt: string;
  /** Non-empty when retry must preserve a captured source context. */
  sourceContextId: string;
  /** The project the pending issue will land in, when the user picked one. */
  projectId: string;
  /** Non-empty when the modal's picker was a squad; agentId is its leader. */
  squadId: string;
  failureReason: string | null;
  createdAt: string;
}

export interface DerivePendingCreationsInput {
  tasks: readonly AgentTask[] | undefined;
  userId: string | null | undefined;
  /** agent id -> runtime_availability, read off the already-warm agent list. */
  availability: ReadonlyMap<string, string | undefined>;
  dismissed: ReadonlySet<string>;
  now: number;
  /** When set, keep only creations destined for this project. */
  projectId?: string;
}

/** Rows older than this are assumed abandoned and stop occupying the strip. */
export const PENDING_CREATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * CompleteTask links the queue row to its new issue (notifyQuickCreateCompleted
 * -> LinkTaskToIssue) BEFORE it broadcasts task:completed, and the broadcast
 * serialises the pre-link struct. A refetch that lands inside that window can
 * legitimately observe completed + empty issue_id. Hold "nothing was created"
 * back until the row has stayed issue-less past this grace, otherwise a
 * successful create flashes a failure on its way out.
 */
export const PENDING_CREATION_LINK_GRACE_MS = 30_000;

function isPendingQuickCreateRow(task: AgentTask): boolean {
  // `kind` is the server's own classification; `!issue_id` is the
  // reconciliation gate. The moment the agent's `multica issue create` lands,
  // the row gains an issue_id and the card retires itself — no client-side
  // bookkeeping, and no dependence on the task:completed payload, which still
  // carries issue_id: "" because it serialises the pre-link struct.
  return task.kind === "quick_create" && !task.issue_id && Boolean(task.agent_id);
}

export function derivePendingCreations({
  tasks,
  userId,
  availability,
  dismissed,
  now,
  projectId,
}: DerivePendingCreationsInput): PendingCreation[] {
  if (!tasks || tasks.length === 0 || !userId) return [];

  // ClaimAgentTask serialises quick-create-shaped tasks per agent, so a queued
  // row whose agent already has one in flight is waiting on its sibling, not on
  // the runtime. Saying so is the difference between "queued" reading as
  // "stuck" and reading as "next in line".
  const busyAgents = new Set<string>();
  for (const task of tasks) {
    if (!isPendingQuickCreateRow(task)) continue;
    if (
      task.status === "dispatched" ||
      task.status === "running" ||
      task.status === "waiting_local_directory"
    ) {
      busyAgents.add(task.agent_id);
    }
  }

  const rows: PendingCreation[] = [];
  for (const task of tasks) {
    if (!isPendingQuickCreateRow(task)) continue;
    if (task.attribution?.originator?.id !== userId) continue;
    if (dismissed.has(task.id)) continue;
    if (projectId !== undefined && (task.project_id ?? "") !== projectId) continue;
    if (
      task.created_at &&
      now - new Date(task.created_at).getTime() > PENDING_CREATION_MAX_AGE_MS
    ) {
      continue;
    }

    let state: PendingCreationState;
    switch (task.status) {
      case "queued":
        state = busyAgents.has(task.agent_id)
          ? "queued_behind"
          : availability.get(task.agent_id) === "offline"
            ? "queued_offline"
            : "queued";
        break;
      case "dispatched":
      case "running":
      case "waiting_local_directory":
        state = "working";
        break;
      case "failed":
        state = "failed";
        break;
      case "completed":
        if (
          !task.completed_at ||
          now - new Date(task.completed_at).getTime() < PENDING_CREATION_LINK_GRACE_MS
        ) {
          continue;
        }
        state = "unconfirmed";
        break;
      default:
        // Server-driven enum: cancelled never reaches this endpoint, and an
        // unknown status from a newer backend is not something we can describe
        // truthfully — so it must not be described at all.
        continue;
    }

    rows.push({
      taskId: task.id,
      agentId: task.agent_id,
      state,
      prompt: task.quick_create_prompt ?? "",
      sourceContextId: task.quick_create_source_context_id ?? "",
      projectId: task.project_id ?? "",
      squadId: task.squad_id ?? "",
      failureReason: task.failure_reason || null,
      createdAt: task.created_at,
    });
  }

  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return rows;
}
