import type { CockpitMeetingWorkflow, CockpitMeetingWorkflowSummary, CockpitMinutesVersion, CockpitWorkflowCommandResponse } from "../types";
import { workflowFixture } from "./workflow-test-fixtures";

export const HISTORY_WORKSPACE_ID = "ws-history";

export function versionMetadataFixture(version: CockpitMinutesVersion) {
  const { content: _content, feedback, ...metadata } = version;
  return { ...metadata, has_feedback: Boolean(feedback) };
}

export function workflowSummaryFixture(legacy: CockpitMeetingWorkflow = workflowFixture()): CockpitMeetingWorkflowSummary {
  const { versions, reviewer_handoffs, nas_exports, ...header } = legacy;
  const current = versions.find((version) => version.id === header.current_version_id);
  const published = versions.find((version) => version.id === header.published_version_id);
  return { ...header, representation: "summary", workspace_id: HISTORY_WORKSPACE_ID,
    current_version: current ? versionMetadataFixture(current) : null,
    published_version: published ? versionMetadataFixture(published) : null,
    published_nas_export: null,
    history_counts: { versions: versions.length, reviewer_handoffs: reviewer_handoffs.length, nas_exports: nas_exports.length,
      nas_active: nas_exports.filter((job) => ["queued", "running", "retry_wait"].includes(job.status)).length },
  };
}

export function compactFixture(workflow: CockpitMeetingWorkflowSummary, receipt: Partial<CockpitWorkflowCommandResponse["receipt"]>): CockpitWorkflowCommandResponse {
  return { representation: "compact", workspace_id: workflow.workspace_id, meeting_id: workflow.meeting_id, workflow,
    receipt: { action: "submitted", version: null, handoff: null, nas_export: null, ...receipt } };
}
