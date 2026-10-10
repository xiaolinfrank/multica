import type { CockpitMeetingWorkflow, CockpitNasDestination, CockpitNasExport } from "../types";
import { isAbsoluteCollabPath } from "../projects/collab-path";

export function sameCockpitNasDestination(a: CockpitNasDestination | null, b: CockpitNasDestination | null): boolean {
  return Boolean(a && b && a.root_id === b.root_id && a.directory === b.directory);
}

export function cockpitNasDestination(workflow: Pick<CockpitMeetingWorkflow, "nas_destination">): CockpitNasDestination | null {
  const destination = workflow.nas_destination;
  return destination?.root_id.trim() && isAbsoluteCollabPath(destination.directory) ? destination : null;
}

export function cockpitNasExportMatchesVersion(workflow: CockpitMeetingWorkflow, job: CockpitNasExport): boolean {
  const version = workflow.versions.find((entry) => entry.id === job.version_id);
  return Boolean(workflow.enabled && version?.published_at && version.decision === "approved"
    && version.content_hash && job.content_hash === version.content_hash
    && job.source_issue_id === version.source_issue_id && job.source_issue_id === workflow.minutes_issue?.id
    && job.version_number === version.version_number && job.id && job.revision > 0 && job.root_id
    && isAbsoluteCollabPath(job.directory) && isAbsoluteCollabPath(job.target_path)
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
