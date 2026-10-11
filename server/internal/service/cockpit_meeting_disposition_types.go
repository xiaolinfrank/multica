package service

// The counts distinguish terminal issue state from task cancellation. Closing
// an issue does not stop its active runs or unrelated queued work.
type CockpitDispositionIssue struct {
	Issue                   CockpitIssueSummary    `json:"issue"`
	IssueRevision           int64                  `json:"issue_revision"`
	CanCancel               bool                   `json:"can_cancel"`
	CanChangeDueDate        bool                   `json:"can_change_due_date"`
	CanLinkMeeting          bool                   `json:"can_link_meeting"`
	CancelStatus            *string                `json:"cancel_status"`
	BlockedReasons          []string               `json:"blocked_reasons"`
	OrdinaryWakeupCount     int64                  `json:"ordinary_wakeup_count"`
	SystemRuleCount         int64                  `json:"system_rule_count"`
	UnstartedWakeupRunCount int64                  `json:"unstarted_wakeup_run_count"`
	OtherQueuedRunCount     int64                  `json:"other_queued_run_count"`
	ActiveRunCount          int64                  `json:"active_run_count"`
	AgendaTotal             int64                  `json:"agenda_total"`
	Targets                 []IssueOperationTarget `json:"targets"`
	TargetsTotal            int64                  `json:"targets_total"`
	ParentIssueID           *string                `json:"parent_issue_id"`
	EvaluatesParentRules    bool                   `json:"evaluates_parent_rules"`
}

type CockpitCancellationImpactPage struct {
	WorkspaceID       string                    `json:"workspace_id"`
	MeetingID         string                    `json:"meeting_id"`
	LifecycleRevision int64                     `json:"lifecycle_revision"`
	Query             string                    `json:"q"`
	PageSize          int32                     `json:"page_size"`
	Items             []CockpitDispositionIssue `json:"items"`
	Total             int64                     `json:"total"`
	NextCursor        *string                   `json:"next_cursor"`
}

type CockpitDispositionRun struct {
	ID             string   `json:"id"`
	IssueID        string   `json:"issue_id"`
	AgentID        string   `json:"agent_id"`
	AgentName      string   `json:"agent_name"`
	Status         string   `json:"status"`
	StartedAt      *string  `json:"started_at"`
	IsWakeup       bool     `json:"is_wakeup"`
	CanStop        bool     `json:"can_stop"`
	BlockedReasons []string `json:"blocked_reasons"`
}

type CockpitDispositionRunPage struct {
	WorkspaceID string                  `json:"workspace_id"`
	MeetingID   string                  `json:"meeting_id"`
	IssueID     string                  `json:"issue_id"`
	PageSize    int32                   `json:"page_size"`
	Items       []CockpitDispositionRun `json:"items"`
	Total       int64                   `json:"total"`
	NextCursor  *string                 `json:"next_cursor"`
}

type CockpitCancellationIssueChoice struct {
	IssueID          string  `json:"issue_id"`
	ExpectedRevision int64   `json:"expected_revision"`
	Action           string  `json:"action"`
	CancelStatus     *string `json:"cancel_status"`
	DueDate          *string `json:"due_date"`
	TargetMeetingID  *string `json:"target_meeting_id"`
	TargetAgendaID   *string `json:"target_agenda_id"`
}

type CockpitCancellationPreviewInput struct {
	Reason string                           `json:"reason"`
	Issues []CockpitCancellationIssueChoice `json:"issues"`
	RunIDs []string                         `json:"run_ids"`
}

type CockpitCancellationPreview struct {
	Intent               string                            `json:"intent"`
	WorkspaceID          string                            `json:"workspace_id"`
	MeetingID            string                            `json:"meeting_id"`
	LifecycleRevision    int64                             `json:"lifecycle_revision"`
	ContextToken         string                            `json:"context_token"`
	Occurrence           CockpitOccurrenceView             `json:"occurrence"`
	AffectedIssueTotal   int64                             `json:"affected_issue_total"`
	UnselectedIssueTotal int64                             `json:"unselected_issue_total"`
	ActiveRunTotal       int64                             `json:"active_run_total"`
	UnselectedRunTotal   int64                             `json:"unselected_run_total"`
	Effects              []CockpitPreparationPreviewEffect `json:"effects"`
	SelectedTotal        int32                             `json:"selected_total"`
	CanConfirm           bool                              `json:"can_confirm"`
	BlockedReasons       []string                          `json:"blocked_reasons"`
}

type CockpitCancellationInput struct {
	CockpitLifecycleCommandInput
	CockpitCancellationPreviewInput
	ContextToken string `json:"context_token"`
}

type CockpitMeetingDispositionInput struct {
	CockpitLifecycleCommandInput
	Transition string `json:"transition"`
	Reason     string `json:"reason"`
}

type CockpitMeetingArchiveView struct {
	ArchivedAt *string `json:"archived_at"`
	ArchivedBy *string `json:"archived_by"`
	Reason     string  `json:"reason"`
}

type CockpitMeetingPendingCounts struct {
	MinutesReview           int64 `json:"minutes_review"`
	DraftActions            int64 `json:"draft_actions"`
	ActivePreparationIssues int64 `json:"active_preparation_issues"`
	ActiveRuns              int64 `json:"active_runs"`
	NASOperations           int64 `json:"nas_operations"`
	PreparationOperations   int64 `json:"preparation_operations"`
}

// This projection is independent of list pages and is not a write permission.
// All command handlers recheck the corresponding transactional guards.
type CockpitMeetingOperationBasis struct {
	AppendDisposition IssueOperationField                `json:"append_disposition"`
	WorkspaceID       string                             `json:"workspace_id"`
	MeetingID         string                             `json:"meeting_id"`
	SchemaVersion     int                                `json:"schema_version"`
	GeneratedAt       string                             `json:"generated_at"`
	Availability      string                             `json:"availability"`
	LifecycleRevision *int64                             `json:"lifecycle_revision"`
	Delete            IssueOperationField                `json:"delete"`
	Cancel            IssueOperationField                `json:"cancel"`
	Reinstate         IssueOperationField                `json:"reinstate"`
	Archive           IssueOperationField                `json:"archive"`
	Unarchive         IssueOperationField                `json:"unarchive"`
	AddPreparation    IssueOperationField                `json:"add_preparation"`
	ApplyTemplate     IssueOperationField                `json:"apply_template"`
	CanAddPreparation bool                               `json:"can_add_preparation"`
	Pending           CockpitMeetingPendingCounts        `json:"pending"`
	CurrentOperation  *CockpitPreparationOperationHeader `json:"current_operation"`
	Targets           []IssueOperationTarget             `json:"targets"`
	TargetsTotal      int64                              `json:"targets_total"`
}
