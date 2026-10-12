import type { CockpitMeetingWorkflow, CockpitMinutesVersion, CockpitNasExport, CockpitReviewerHandoff, CockpitMeetingWorkflowSetup,
  CockpitMeetingReadinessPatch, CockpitMinutesSubmission, CockpitMinutesReview, CockpitReviewerHandoffCommand, CockpitNasDestination } from "./cockpit";

/** Version identity and formal outcome, without the immutable document body. */
export interface CockpitMinutesVersionMetadata extends Omit<CockpitMinutesVersion, "content" | "feedback"> {
  has_feedback: boolean;
}

export interface CockpitWorkflowNasExport extends CockpitNasExport {
  source_version: CockpitMinutesVersionMetadata;
}

export interface CockpitWorkflowReviewerHandoff extends CockpitReviewerHandoff {
  version_number: number | null;
}

/** The selected meeting's bounded working state; history is queried separately. */
export interface CockpitMeetingWorkflowSummary extends Omit<CockpitMeetingWorkflow, "versions" | "reviewer_handoffs" | "nas_exports"> {
  representation: "summary";
  workspace_id: string;
  current_version: CockpitMinutesVersionMetadata | null;
  published_version: CockpitMinutesVersionMetadata | null;
  published_nas_export: CockpitWorkflowNasExport | null;
  history_counts: { versions: number; reviewer_handoffs: number; nas_exports: number; nas_active: number };
}

export interface CockpitWorkflowHistoryPage<T> {
  workspace_id: string;
  meeting_id: string;
  workflow_revision: number;
  items: T[];
  total: number;
  next_cursor: string | null;
}

export interface CockpitWorkflowHistoryQuery {
  cursor?: string;
  page_size?: number;
}

export interface CockpitWorkflowExportQuery extends CockpitWorkflowHistoryQuery {
  version_id?: string;
  status?: string;
}

export interface CockpitWorkflowExportPage extends CockpitWorkflowHistoryPage<CockpitWorkflowNasExport> {
  version_id: string | null;
  status: string;
}

export interface CockpitMinutesVersionDetail {
  workspace_id: string;
  meeting_id: string;
  workflow_revision: number;
  version: CockpitMinutesVersion;
  can_review: boolean;
  can_publish: boolean;
  can_export_nas: boolean;
}

export interface CockpitWorkflowCommandResponse {
  representation: "compact";
  workspace_id: string;
  meeting_id: string;
  workflow: CockpitMeetingWorkflowSummary;
  receipt: {
    action: string;
    version: CockpitMinutesVersion | null;
    handoff: CockpitWorkflowReviewerHandoff | null;
    nas_export: CockpitWorkflowNasExport | null;
  };
}

export type CockpitWorkflowCommand =
  | { action: "enabled"; body: CockpitMeetingWorkflowSetup }
  | { action: "readiness"; body: CockpitMeetingReadinessPatch }
  | { action: "released"; body: { expected_revision: number } }
  | { action: "submitted"; body: CockpitMinutesSubmission }
  | { action: "reviewed"; version_id: string; body: CockpitMinutesReview }
  | { action: "published"; version_id: string; body: { expected_revision: number; nas_export?: CockpitNasDestination } }
  | { action: "reviewer_reassigned"; body: CockpitReviewerHandoffCommand }
  | { action: "bound"; body: { issue_id: string; expected_revision: number } }
  | { action: "unbound"; issue_id: string; expected_revision: number }
  | { action: "focused"; body: { issue_id: string; expected_revision: number } }
  | { action: "nas_export_queued"; version_id: string; body: CockpitNasDestination }
  | { action: "nas_export_retried"; operation: CockpitWorkflowNasExport };
