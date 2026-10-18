import type { CockpitMeetingWorkflow, CockpitNasDestination, CockpitNasExport } from "../types";
import { isAbsoluteCollabPath } from "../projects/collab-path";
import type { CockpitNasAttempt } from "../types/cockpit-nas-attempts";

export function sameCockpitNasDestination(a: CockpitNasDestination | null, b: CockpitNasDestination | null): boolean {
  return Boolean(a && b && a.root_id === b.root_id && a.directory === b.directory
    && cockpitNasWriteMode(a) === cockpitNasWriteMode(b));
}

export function cockpitNasWriteMode(value: { write_mode?: string }): string { return value.write_mode ?? "atomic"; }

function nonzeroNasUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) && value !== "00000000-0000-0000-0000-000000000000";
}

export function cockpitNasAttemptBelongsToExport(attempt: CockpitNasAttempt, exportId: string): boolean {
  if (!nonzeroNasUUID(attempt.id) || !nonzeroNasUUID(exportId)) return false;
  const parts = attempt.target_path.split("/");
  if (!attempt.target_path.startsWith("/") || parts.slice(1).some((part) => !part || part === "." || part === "..")
    || parts.at(-3) !== exportId || parts.at(-2) !== attempt.id) return false;
  const directory = parts.slice(0, -1).join("/");
  if (attempt.receipt_path !== `${directory}/.multica-complete.json`) return false;
  if (!["verified", "recovered"].includes(attempt.status)) return true;
  if (!attempt.verified_attempt_id || !nonzeroNasUUID(attempt.verified_attempt_id)) return false;
  const verifiedDirectory = `${parts.slice(0, -2).join("/")}/${attempt.verified_attempt_id}`;
  return attempt.verified_path === `${verifiedDirectory}/${parts.at(-1)}`
    && attempt.verified_receipt_path === `${verifiedDirectory}/.multica-complete.json`;
}

/** Recorded verification is a point-in-time receipt, not a fresh filesystem probe. */
export function cockpitNasCopyEvidenceValid(job: CockpitNasExport): boolean {
  const mode = cockpitNasWriteMode(job);
  if (mode === "atomic") return true;
  if (mode !== "create_only") return false;
  if (job.status !== "succeeded") return true;
  if (!nonzeroNasUUID(job.id) || !job.verified_attempt_id || !nonzeroNasUUID(job.verified_attempt_id)
    || !job.receipt_hash || !/^[0-9a-f]{64}$/.test(job.receipt_hash) || !job.size_bytes || job.size_bytes < 1
    || !job.target_path.startsWith(`${job.directory.replace(/\/$/, "")}/`)
    || job.target_path.split("/").some((part) => part === "." || part === "..")) return false;
  const slash = job.target_path.lastIndexOf("/");
  const attempt = `${job.target_path.slice(0, slash)}/${job.id}/${job.verified_attempt_id}`;
  return job.verified_path === `${attempt}/${job.target_path.slice(slash + 1)}` && job.receipt_path === `${attempt}/.multica-complete.json`;
}

export function cockpitNasDestination(workflow: Pick<CockpitMeetingWorkflow, "nas_destination">): CockpitNasDestination | null {
  const destination = workflow.nas_destination;
  return destination?.root_id.trim() && isAbsoluteCollabPath(destination.directory)
    && ["atomic", "create_only"].includes(cockpitNasWriteMode(destination)) ? destination : null;
}

export function cockpitNasExportMatchesVersion(workflow: CockpitMeetingWorkflow, job: CockpitNasExport): boolean {
  const version = workflow.versions.find((entry) => entry.id === job.version_id);
  return Boolean(workflow.enabled && version?.published_at && version.decision === "approved"
    && version.content_hash && job.content_hash === version.content_hash
    && job.source_issue_id === version.source_issue_id && job.source_issue_id === workflow.minutes_issue?.id
    && job.version_number === version.version_number && job.id && job.revision > 0 && job.root_id
    && isAbsoluteCollabPath(job.directory) && isAbsoluteCollabPath(job.target_path)
    && cockpitNasCopyEvidenceValid(job)
    && (job.status !== "succeeded" || (job.completed_at && job.size_bytes !== null)));
}

export function acknowledgedCockpitNasExport(workflow: CockpitMeetingWorkflow, versionId: string, destination: CockpitNasDestination) {
  return workflow.nas_exports.find((job) => job.version_id === versionId && sameCockpitNasDestination(job, destination)
    && cockpitNasExportMatchesVersion(workflow, job)) ?? null;
}

export function canRetryCockpitNasExport(workflow: CockpitMeetingWorkflow, job: CockpitNasExport, userId: string): boolean {
  return Boolean(userId && job.can_retry && ["retry_wait", "needs_attention"].includes(job.status)
    && cockpitNasExportMatchesVersion(workflow, job));
}

export function cockpitNasExportActions(workflow: CockpitMeetingWorkflow, userId: string) {
  const published = workflow.versions.find((version) => version.id === workflow.published_version_id) ?? null;
  const destination = cockpitNasDestination(workflow);
  const existing = destination ? workflow.nas_exports.find((job) => job.version_id === published?.id
    && sameCockpitNasDestination(job, destination)) ?? null : null;
  const canExport = Boolean(workflow.enabled && userId && workflow.can_export_nas && published?.published_at
    && published.decision === "approved" && published.content_hash && published.source_issue_id === workflow.minutes_issue?.id
    && (workflow.can_manage || published.reviewer_id === userId) && destination && !existing);
  return { published, destination, existing, canExport };
}

/** Business and export operations have independent clocks; neither may roll back the other. */
export function mergeCockpitWorkflowResponse(current: CockpitMeetingWorkflow | undefined, incoming: CockpitMeetingWorkflow): CockpitMeetingWorkflow {
  if (!current || current.meeting_id !== incoming.meeting_id) return incoming;
  const latest = current.revision > incoming.revision ? current : incoming;
  const jobs = new Map(current.nas_exports.map((job) => [job.id, job]));
  for (const job of incoming.nas_exports) {
    const existing = jobs.get(job.id);
    if (!existing || existing.revision <= job.revision) jobs.set(job.id, job);
  }
  return { ...latest, nas_exports: [...jobs.values()] };
}

/** A selected meeting gets a five-minute recovery window; WebSocket updates remain authoritative. */
export function cockpitNasPollInterval(workflow: CockpitMeetingWorkflow | undefined, deadline: number, now = Date.now()): number | false {
  if (!workflow?.enabled || now >= deadline || !workflow.nas_exports.some((job) => ["queued", "running", "retry_wait"].includes(job.status))) return false;
  return 10_000;
}
