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
type CockpitAgendaInput struct {
	CockpitLifecycleCommandInput
	Title             *string         `json:"title,omitempty"`
	Purposes          *[]string       `json:"purposes,omitempty"`
	DesiredOutcome    *string         `json:"desired_outcome,omitempty"`
	Notes             *string         `json:"notes,omitempty"`
	FacilitatorUserID json.RawMessage `json:"facilitator_user_id,omitempty"`
	NodeID            json.RawMessage `json:"node_id,omitempty"`
	SortOrder         *int64          `json:"sort_order,omitempty"`
}
type CockpitAgendaRemoveInput struct {
	CockpitLifecycleCommandInput
	Reason string `json:"reason"`
}
type CockpitAgendaReferenceInput struct {
	CockpitLifecycleCommandInput
	Kind     string `json:"kind"`
	TargetID string `json:"target_id"`
	Purpose  string `json:"purpose"`
}
type CockpitPreparationIssueInput struct {
	CockpitLifecycleCommandInput
	PrimaryNodeID *string                       `json:"primary_node_id"`
	NewIssue      CockpitPreparationIssueFields `json:"new_issue"`
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
	AgendaID       pgtype.UUID
	Query, Cursor  string
	IncludeRemoved bool
	PageSize       int32
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
	WorkspaceID         string                  `json:"workspace_id"`
	MeetingID           string                  `json:"meeting_id"`
	LifecycleRevision   int64                   `json:"lifecycle_revision"`
	AgendaRevision      int64                   `json:"agenda_revision"`
	GeneratedAt         string                  `json:"generated_at"`
	Occurrence          CockpitOccurrenceView   `json:"occurrence"`
	Materials           *CockpitMaterialsView   `json:"materials"`
	WorkflowEnabled     bool                    `json:"workflow_enabled"`
	AgendaTotal         int64                   `json:"agenda_total"`
	CanSchedule         bool                    `json:"can_schedule"`
	CanStart            bool                    `json:"can_start"`
	CanEnd              bool                    `json:"can_end"`
	CanCorrectTimes     bool                    `json:"can_correct_times"`
	CanEditAgenda       bool                    `json:"can_edit_agenda"`
	CanConfirmMaterials bool                    `json:"can_confirm_materials"`
	BlockedReasons      []CockpitLifecycleBlock `json:"blocked_reasons"`
}
type CockpitAgendaMetadata struct {
	ID                string   `json:"id"`
	WorkspaceID       string   `json:"workspace_id"`
	MeetingID         string   `json:"meeting_id"`
	Revision          int64    `json:"revision"`
	Title             string   `json:"title"`
	Purposes          []string `json:"purposes"`
	SortOrder         int64    `json:"sort_order"`
	FacilitatorUserID *string  `json:"facilitator_user_id"`
	FacilitatorName   string   `json:"facilitator_name"`
	NodeID            *string  `json:"node_id"`
	NodeCode          string   `json:"node_code"`
	NodeTitle         string   `json:"node_title"`
	ReferenceCount    int64    `json:"reference_count"`
	CreatedAt         string   `json:"created_at"`
	UpdatedAt         string   `json:"updated_at"`
	RemovedAt         *string  `json:"removed_at"`
	CanEdit           bool     `json:"can_edit"`
	CanRemove         bool     `json:"can_remove"`
}
type CockpitAgendaDetail struct {
	CockpitAgendaMetadata
	DesiredOutcome string `json:"desired_outcome"`
	Notes          string `json:"notes"`
}
type CockpitAgendaPage struct {
	WorkspaceID    string                  `json:"workspace_id"`
	MeetingID      string                  `json:"meeting_id"`
	AgendaRevision int64                   `json:"agenda_revision"`
	Query          string                  `json:"q"`
	IncludeRemoved bool                    `json:"include_removed"`
	PageSize       int32                   `json:"page_size"`
	Items          []CockpitAgendaMetadata `json:"items"`
	Total          int64                   `json:"total"`
	NextCursor     *string                 `json:"next_cursor"`
}
type CockpitAgendaReferenceView struct {
	ID              string               `json:"id"`
	WorkspaceID     string               `json:"workspace_id"`
	MeetingID       string               `json:"meeting_id"`
	AgendaID        string               `json:"agenda_id"`
	Kind            string               `json:"kind"`
	TargetID        string               `json:"target_id"`
	Purpose         string               `json:"purpose"`
	Available       bool                 `json:"available"`
	Label           string               `json:"label"`
	Issue           *CockpitIssueSummary `json:"issue"`
	ArtifactID      *string              `json:"artifact_id"`
	VersionID       *string              `json:"version_id"`
	VersionNumber   *int32               `json:"version_number"`
	VersionDecision *string              `json:"version_decision"`
	ContentHash     *string              `json:"content_hash"`
	CreatedAt       string               `json:"created_at"`
	RemovedAt       *string              `json:"removed_at"`
	CanRemove       bool                 `json:"can_remove"`
}
type CockpitAgendaReferencePage struct {
	WorkspaceID    string                       `json:"workspace_id"`
	MeetingID      string                       `json:"meeting_id"`
	AgendaID       string                       `json:"agenda_id"`
	AgendaRevision int64                        `json:"agenda_revision"`
	IncludeRemoved bool                         `json:"include_removed"`
	PageSize       int32                        `json:"page_size"`
	Items          []CockpitAgendaReferenceView `json:"items"`
	Total          int64                        `json:"total"`
	NextCursor     *string                      `json:"next_cursor"`
}
type CockpitLifecycleReceipt struct {
	Reason             string                      `json:"reason"`
	PreviousOccurrence *CockpitOccurrenceView      `json:"previous_occurrence"`
	Revision           int64                       `json:"revision"`
	AgendaRevision     int64                       `json:"agenda_revision"`
	AgendaID           *string                     `json:"agenda_id"`
	ReferenceID        *string                     `json:"reference_id"`
	IssueID            *string                     `json:"issue_id"`
	RequestHash        string                      `json:"request_hash"`
	Occurrence         *CockpitOccurrenceView      `json:"occurrence"`
	Materials          *CockpitMaterialsView       `json:"materials"`
	Agenda             *CockpitAgendaDetail        `json:"agenda"`
	Reference          *CockpitAgendaReferenceView `json:"reference"`
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
	CommandKey  string  `json:"command_key"`
	Action      string  `json:"action"`
	ActorID     string  `json:"actor_id"`
	ActorName   string  `json:"actor_name"`
	CreatedAt   string  `json:"created_at"`
	Revision    int64   `json:"revision"`
	AgendaID    *string `json:"agenda_id"`
	ReferenceID *string `json:"reference_id"`
	IssueID     *string `json:"issue_id"`
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
