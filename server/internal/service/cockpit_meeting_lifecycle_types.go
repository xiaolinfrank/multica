package service

import (
	"encoding/json"

	"github.com/jackc/pgx/v5/pgtype"
)

// Raw nullable inputs distinguish omission (keep) from JSON null (clear).
type CockpitLifecycleCommandInput struct {
	CommandKey       string `json:"command_key"`
	ExpectedRevision int64  `json:"expected_revision"`
}
type CockpitOccurrenceInput struct {
	CockpitLifecycleCommandInput
	Transition      string          `json:"transition"`
	ActualStartedAt json.RawMessage `json:"actual_started_at,omitempty"`
	ActualEndedAt   json.RawMessage `json:"actual_ended_at,omitempty"`
	Reason          string          `json:"reason"`
}
type CockpitMaterialsInput struct {
	CockpitLifecycleCommandInput
	MaterialsReady *bool `json:"materials_ready"`
}
type CockpitPreparationIssueFields struct {
	Title        string  `json:"title"`
	Description  string  `json:"description"`
	AssigneeType *string `json:"assignee_type"`
	AssigneeID   *string `json:"assignee_id"`
	Priority     string  `json:"priority"`
	DueDate      *string `json:"due_date"`
	ProjectID    *string `json:"project_id"`
	ModuleID     *string `json:"module_id"`
}
type CockpitLifecycleRead struct {
	WorkspaceID, MeetingID, ActorID pgtype.UUID
	Human                           bool
}
type CockpitLifecycleList struct {
	CockpitLifecycleRead
	Query, Cursor string
	PageSize      int32
}
type CockpitOccurrenceView struct {
	State              string  `json:"state"`
	StartedConfirmedAt *string `json:"started_confirmed_at"`
	StartedConfirmedBy *string `json:"started_confirmed_by"`
	EndedAt            *string `json:"ended_at"`
	EndedBy            *string `json:"ended_by"`
	EndedSource        *string `json:"ended_source"`
	ActualStartedAt    *string `json:"actual_started_at"`
	ActualEndedAt      *string `json:"actual_ended_at"`
	CancelledAt        *string `json:"cancelled_at"`
	CancelledBy        *string `json:"cancelled_by"`
	CancelledReason    string  `json:"cancelled_reason"`
}
type CockpitMaterialsView struct {
	WorkflowRevision int64   `json:"workflow_revision"`
	Ready            bool    `json:"ready"`
	ConfirmedAt      *string `json:"confirmed_at"`
	ConfirmedBy      *string `json:"confirmed_by"`
	Released         bool    `json:"released"`
}
type CockpitLifecycleBlock struct {
	Action string `json:"action"`
	Code   string `json:"code"`
}
type CockpitMeetingLifecycleHeader struct {
	// Retired affordances remain explicitly disabled for installed clients.
	AgendaRevision      int64                     `json:"agenda_revision"`
	AgendaTotal         int64                     `json:"agenda_total"`
	CanEditAgenda       bool                      `json:"can_edit_agenda"`
	WorkspaceID         string                    `json:"workspace_id"`
	MeetingID           string                    `json:"meeting_id"`
	LifecycleRevision   int64                     `json:"lifecycle_revision"`
	GeneratedAt         string                    `json:"generated_at"`
	Occurrence          CockpitOccurrenceView     `json:"occurrence"`
	Materials           *CockpitMaterialsView     `json:"materials"`
	WorkflowEnabled     bool                      `json:"workflow_enabled"`
	CanSchedule         bool                      `json:"can_schedule"`
	CanEnd              bool                      `json:"can_end"`
	CanCorrectTimes     bool                      `json:"can_correct_times"`
	CanReopen           bool                      `json:"can_reopen"`
	CanUnschedule       bool                      `json:"can_unschedule"`
	CanConfirmMaterials bool                      `json:"can_confirm_materials"`
	BlockedReasons      []CockpitLifecycleBlock   `json:"blocked_reasons"`
	Archive             CockpitMeetingArchiveView `json:"archive"`
}
type CockpitLifecycleReceipt struct {
	// Historical receipt payloads are data only; no retired edit API is exposed.
	AgendaRevision     int64                             `json:"agenda_revision"`
	AgendaID           *string                           `json:"agenda_id"`
	Agenda             json.RawMessage                   `json:"agenda"`
	Reference          json.RawMessage                   `json:"reference"`
	Reason             string                            `json:"reason"`
	PreviousOccurrence *CockpitOccurrenceView            `json:"previous_occurrence"`
	Revision           int64                             `json:"revision"`
	ReferenceID        *string                           `json:"reference_id"`
	IssueID            *string                           `json:"issue_id"`
	RequestHash        string                            `json:"request_hash"`
	Occurrence         *CockpitOccurrenceView            `json:"occurrence"`
	Materials          *CockpitMaterialsView             `json:"materials"`
	Archive            *CockpitMeetingArchiveView        `json:"archive"`
	PreviousArchive    *CockpitMeetingArchiveView        `json:"previous_archive"`
	Preparation        *CockpitPreparationCommandReceipt `json:"preparation"`
	Directory          *CockpitDirectoryCommandReceipt   `json:"directory"`
}
type CockpitLifecycleCommandResult struct {
	WorkspaceID string                        `json:"workspace_id"`
	MeetingID   string                        `json:"meeting_id"`
	CommandKey  string                        `json:"command_key"`
	Action      string                        `json:"action"`
	Replayed    bool                          `json:"replayed"`
	Receipt     CockpitLifecycleReceipt       `json:"receipt"`
	Current     CockpitMeetingLifecycleHeader `json:"current"`
}
type CockpitLifecycleCommandMetadata struct {
	AgendaID             *string `json:"agenda_id"`
	CommandKey           string  `json:"command_key"`
	Action               string  `json:"action"`
	ActorID              string  `json:"actor_id"`
	ActorType            string  `json:"actor_type"`
	ActorName            string  `json:"actor_name"`
	CreatedAt            string  `json:"created_at"`
	Revision             int64   `json:"revision"`
	ReferenceID          *string `json:"reference_id"`
	IssueID              *string `json:"issue_id"`
	OperationID          *string `json:"operation_id"`
	EffectID             *string `json:"effect_id"`
	DirectoryOperationID *string `json:"directory_operation_id"`
	DirectoryStepID      *string `json:"directory_step_id"`
}
type CockpitLifecycleCommandPage struct {
	WorkspaceID string                            `json:"workspace_id"`
	MeetingID   string                            `json:"meeting_id"`
	PageSize    int32                             `json:"page_size"`
	Items       []CockpitLifecycleCommandMetadata `json:"items"`
	Total       int64                             `json:"total"`
	NextCursor  *string                           `json:"next_cursor"`
}

type CockpitLifecycleCommandDetail struct {
	WorkspaceID string `json:"workspace_id"`
	MeetingID   string `json:"meeting_id"`
	CockpitLifecycleCommandMetadata
	Receipt CockpitLifecycleReceipt `json:"receipt"`
}
