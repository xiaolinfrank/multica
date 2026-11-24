import type { CockpitStatusNotInWorkflow } from "../types/cockpit";
import type { RunningAgentTask } from "../types/directory";
import { CockpitStatusNotInWorkflowBodySchema } from "../api/schemas";
import { RunningAgentTasksRefusalSchema } from "../api/directory-schemas";
import { parseWithFallback } from "../api/schema";

// Plan-write errors (S3/S4). The server gives each refusal a reason a reader
// can act on; folding all of them into "save failed" would throw that away.
// Keep the status code, the server's message and — for the status mapping — a
// typed description of the workflow that refused it.

/** A work-item move whose status mapping lands outside the target workflow.
 *  Same refusal the issue detail path produces; carries the issue, the target
 *  workflow's name and its allowed statuses so the UI can say what to do. */
export class CockpitStatusNotInWorkflowError extends Error {
  readonly detail: CockpitStatusNotInWorkflow;
  constructor(detail: CockpitStatusNotInWorkflow) {
    super(detail.message || "status_not_in_workflow");
    this.name = "CockpitStatusNotInWorkflowError";
    this.detail = detail;
  }
}

/** A plan write the server refused with a status and a message worth showing
 *  as-is: a 400 about a structure rule, or the 409 a second reconcile returns. */
export class CockpitPlanWriteRefusedError extends Error {
  readonly status: number;
  readonly message: string;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "CockpitPlanWriteRefusedError";
    this.status = status;
    this.message = message;
    this.code = code;
  }
}

/** A structural write (rename, move, renumber) refused because an agent is
 *  working in the folder it would rename. The reader chooses "sync now"
 *  (`force`) or "later" (`defer`); nothing was written. */
export class CockpitRunningTasksError extends CockpitPlanWriteRefusedError {
  readonly runningTasks: RunningAgentTask[];
  constructor(message: string, runningTasks: RunningAgentTask[]) {
    super(message, 409, "running_agent_tasks");
    this.name = "CockpitRunningTasksError";
    this.runningTasks = runningTasks;
  }
}

/** Branch on this rather than on `.code`: a thrown error crosses package
 *  boundaries where `instanceof` is not reliable. */
export function isCockpitRunningTasksError(error: unknown): error is CockpitRunningTasksError {
  return error instanceof CockpitRunningTasksError
    || (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "running_agent_tasks"
      && Array.isArray((error as { runningTasks?: unknown }).runningTasks));
}

/** A second apply of the one-time reconcile is refused with 409. Distinguish
 *  that from every other refusal so the UI can say "already reconciled" instead
 *  of showing a generic error. */
export function isCockpitReconcileAlreadyApplied(error: unknown): boolean {
  return (
    error instanceof CockpitPlanWriteRefusedError && error.status === 409
  ) || (typeof error === "object" && error !== null && "status" in error && (error as { status?: unknown }).status === 409);
}

/** Translate an HTTP error from a plan write into the typed errors above.
 *  Non-API errors pass through unchanged. */
export function cockpitWriteError(error: unknown): Error {
  const status = (error as { status?: unknown })?.status;
  if (typeof status !== "number") return error instanceof Error ? error : new Error(String(error));
  const body = (error as { body?: unknown })?.body;
  const message =
    typeof (body as { error?: unknown })?.error === "string"
      ? (body as { error: string }).error
      : error instanceof Error
        ? error.message
        : "plan write refused";
  if (status === 400) {
    const parsed = parseWithFallback<import("zod").z.infer<typeof CockpitStatusNotInWorkflowBodySchema> | null>(body, CockpitStatusNotInWorkflowBodySchema, null, {
      endpoint: "plan write refusal",
    });
    if (parsed?.code === "status_not_in_workflow") {
      return new CockpitStatusNotInWorkflowError({
        issue: parsed.issue,
        allowed_statuses: parsed.allowed_statuses,
        workflow_name: parsed.workflow_name,
        message: parsed.error || message,
      });
    }
  }
  if (status === 409) {
    const refusal = parseWithFallback<import("zod").z.infer<typeof RunningAgentTasksRefusalSchema> | null>(
      body, RunningAgentTasksRefusalSchema, null, { endpoint: "plan write refusal (running tasks)" },
    );
    if (refusal) return new CockpitRunningTasksError(refusal.error || message, refusal.running_tasks);
  }
  return new CockpitPlanWriteRefusedError(message, status, (body as { code?: unknown })?.code as string | undefined);
}
