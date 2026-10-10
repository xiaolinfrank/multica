package handler

import "github.com/multica-ai/multica/server/internal/cockpitnas"

// Metadata deliberately excludes the minutes body and review feedback text.
type CockpitMinutesVersionMetadata struct {
	ID              string                        `json:"id"`
	VersionNumber   int32                         `json:"version_number"`
	SubmissionKey   string                        `json:"submission_key"`
	ContentHash     string                        `json:"content_hash"`
	SourceIssueID   string                        `json:"source_issue_id"`
	ReviewIssue     *CockpitWorkflowIssueResponse `json:"review_issue"`
	ReviewerID      string                        `json:"reviewer_id"`
	Decision        string                        `json:"decision"`
	HasFeedback     bool                          `json:"has_feedback"`
	SubmittedByType string                        `json:"submitted_by_type"`
	SubmittedByID   string                        `json:"submitted_by_id"`
	CreatedAt       string                        `json:"created_at"`
	ReviewedBy      *string                       `json:"reviewed_by"`
	ReviewedAt      *string                       `json:"reviewed_at"`
	PublishedBy     *string                       `json:"published_by"`
	PublishedAt     *string                       `json:"published_at"`
}

type CockpitWorkflowHistoryCounts struct {
	Versions         int64 `json:"versions"`
	ReviewerHandoffs int64 `json:"reviewer_handoffs"`
	NASExports       int64 `json:"nas_exports"`
	NASActive        int64 `json:"nas_active"`
}

type CockpitWorkflowSummaryResponse struct {
	Representation       string                         `json:"representation"`
	WorkspaceID          string                         `json:"workspace_id"`
	Enabled              bool                           `json:"enabled"`
	MeetingID            string                         `json:"meeting_id"`
	Revision             int64                          `json:"revision"`
	EndedAt              *string                        `json:"ended_at"`
	MaterialsReady       bool                           `json:"materials_ready"`
	ReleasedAt           *string                        `json:"released_at"`
	ReleaseTaskID        *string                        `json:"release_task_id"`
	ReviewerID           *string                        `json:"reviewer_id"`
	MinutesIssue         *CockpitWorkflowIssueResponse  `json:"minutes_issue"`
	CurrentVersionID     *string                        `json:"current_version_id"`
	PublishedVersionID   *string                        `json:"published_version_id"`
	CurrentVersion       *CockpitMinutesVersionMetadata `json:"current_version"`
	PublishedVersion     *CockpitMinutesVersionMetadata `json:"published_version"`
	HistoryCounts        CockpitWorkflowHistoryCounts   `json:"history_counts"`
	CanManage            bool                           `json:"can_manage"`
	CanSubmit            bool                           `json:"can_submit"`
	CanReview            bool                           `json:"can_review"`
	CanPublish           bool                           `json:"can_publish"`
	CanReassignReviewer  bool                           `json:"can_reassign_reviewer"`
	NASDestination       *cockpitnas.Directory          `json:"nas_destination"`
	NASUnavailableReason string                         `json:"nas_unavailable_reason"`
	CanExportNAS         bool                           `json:"can_export_nas"`
	PublishedNASExport   *CockpitNASHistoryItem         `json:"published_nas_export"`
}

type CockpitWorkflowHistoryScope struct {
	WorkspaceID      string `json:"workspace_id"`
	MeetingID        string `json:"meeting_id"`
	WorkflowRevision int64  `json:"workflow_revision"`
}

type CockpitMinutesVersionPage struct {
	CockpitWorkflowHistoryScope
	Items      []CockpitMinutesVersionMetadata `json:"items"`
	Total      int64                           `json:"total"`
	NextCursor *string                         `json:"next_cursor"`
}

type CockpitMinutesVersionDetail struct {
	CockpitWorkflowHistoryScope
	Version      CockpitMinutesVersionResponse `json:"version"`
	CanReview    bool                          `json:"can_review"`
	CanPublish   bool                          `json:"can_publish"`
	CanExportNAS bool                          `json:"can_export_nas"`
}

type CockpitHandoffHistoryItem struct {
	CockpitReviewerHandoffResponse
	VersionNumber *int32 `json:"version_number"`
}

type CockpitReviewerHandoffPage struct {
	CockpitWorkflowHistoryScope
	Items      []CockpitHandoffHistoryItem `json:"items"`
	Total      int64                       `json:"total"`
	NextCursor *string                     `json:"next_cursor"`
}

type CockpitNASHistoryItem struct {
	CockpitMinutesExportResponse
	SourceVersion CockpitMinutesVersionMetadata `json:"source_version"`
}

type CockpitNASExportPage struct {
	CockpitWorkflowHistoryScope
	VersionID  *string                 `json:"version_id"`
	Status     string                  `json:"status"`
	Items      []CockpitNASHistoryItem `json:"items"`
	Total      int64                   `json:"total"`
	NextCursor *string                 `json:"next_cursor"`
}

type CockpitWorkflowCommandReceipt struct {
	Action    string                         `json:"action"`
	Version   *CockpitMinutesVersionResponse `json:"version"`
	Handoff   *CockpitHandoffHistoryItem     `json:"handoff"`
	NASExport *CockpitNASHistoryItem         `json:"nas_export"`
}

type CockpitWorkflowCompactResponse struct {
	Representation string                         `json:"representation"`
	WorkspaceID    string                         `json:"workspace_id"`
	MeetingID      string                         `json:"meeting_id"`
	Workflow       CockpitWorkflowSummaryResponse `json:"workflow"`
	Receipt        CockpitWorkflowCommandReceipt  `json:"receipt"`
}
