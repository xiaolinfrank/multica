package service

import "github.com/jackc/pgx/v5/pgtype"

type CockpitPreparationQuery struct {
	CockpitLifecycleRead
	OperationID, EffectID, IssueID pgtype.UUID
	Query, Cursor                  string
	PageSize                       int32
}

// Template configuration is immutable, bounded data. It cannot contain scripts,
// execution instructions, run requests, or filesystem preparation operations.
type CockpitMeetingTemplateConfig struct {
	SchemaVersion int                          `json:"schema_version"`
	Slots         []CockpitMeetingTemplateSlot `json:"slots"`
}

type CockpitMeetingTemplateSlot struct {
	SlotID       string                         `json:"slot_id"`
	Kind         string                         `json:"kind"`
	Label        string                         `json:"label"`
	AgendaSlotID *string                        `json:"agenda_slot_id"`
	Agenda       *CockpitTemplateAgendaDefaults `json:"agenda"`
	NewIssue     *CockpitTemplateIssueDefaults  `json:"new_issue"`
	Purpose      string                         `json:"purpose"`
}

type CockpitTemplateAgendaDefaults struct {
	Title          string   `json:"title"`
	Purposes       []string `json:"purposes"`
	DesiredOutcome string   `json:"desired_outcome"`
	Notes          string   `json:"notes"`
}

type CockpitTemplateIssueDefaults struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Priority    string `json:"priority"`
}

// Saving all fields creates one immutable version, including activation changes.
type CockpitMeetingTemplateSaveInput struct {
	CommandKey       string                       `json:"command_key"`
	ExpectedRevision int64                        `json:"expected_revision"`
	Title            string                       `json:"title"`
	Description      string                       `json:"description"`
	Active           bool                         `json:"active"`
	Config           CockpitMeetingTemplateConfig `json:"config"`
}

type CockpitMeetingTemplateVersionMetadata struct {
	ID            string `json:"id"`
	TemplateID    string `json:"template_id"`
	Number        int32  `json:"number"`
	Title         string `json:"title"`
	Active        bool   `json:"active"`
	SlotCount     int32  `json:"slot_count"`
	ConfigHash    string `json:"config_hash"`
	CommandKey    string `json:"command_key"`
	CreatedBy     string `json:"created_by"`
	CreatedByName string `json:"created_by_name"`
	CreatedAt     string `json:"created_at"`
}

type CockpitMeetingTemplateHeader struct {
	WorkspaceID    string                                `json:"workspace_id"`
	ID             string                                `json:"id"`
	Revision       int64                                 `json:"revision"`
	Title          string                                `json:"title"`
	Description    string                                `json:"description"`
	Active         bool                                  `json:"active"`
	CreatedBy      string                                `json:"created_by"`
	CreatedAt      string                                `json:"created_at"`
	UpdatedAt      string                                `json:"updated_at"`
	CurrentVersion CockpitMeetingTemplateVersionMetadata `json:"current_version"`
	CanEdit        bool                                  `json:"can_edit"`
}

type CockpitMeetingTemplateVersionDetail struct {
	WorkspaceID string `json:"workspace_id"`
	CockpitMeetingTemplateVersionMetadata
	Description string                       `json:"description"`
	Config      CockpitMeetingTemplateConfig `json:"config"`
}

type CockpitMeetingTemplatePage struct {
	WorkspaceID     string                         `json:"workspace_id"`
	Query           string                         `json:"q"`
	IncludeInactive bool                           `json:"include_inactive"`
	PageSize        int32                          `json:"page_size"`
	Items           []CockpitMeetingTemplateHeader `json:"items"`
	Total           int64                          `json:"total"`
	NextCursor      *string                        `json:"next_cursor"`
	CanCreate       bool                           `json:"can_create"`
}

type CockpitMeetingTemplateVersionPage struct {
	WorkspaceID string                                  `json:"workspace_id"`
	TemplateID  string                                  `json:"template_id"`
	PageSize    int32                                   `json:"page_size"`
	Items       []CockpitMeetingTemplateVersionMetadata `json:"items"`
	Total       int64                                   `json:"total"`
	NextCursor  *string                                 `json:"next_cursor"`
}

type CockpitMeetingTemplateSaveResult struct {
	WorkspaceID string                              `json:"workspace_id"`
	TemplateID  string                              `json:"template_id"`
	CommandKey  string                              `json:"command_key"`
	RequestHash string                              `json:"request_hash"`
	Replayed    bool                                `json:"replayed"`
	Receipt     CockpitMeetingTemplateVersionDetail `json:"receipt"`
	Current     CockpitMeetingTemplateHeader        `json:"current"`
}

// Bindings select actual identities for a fixed configuration version. Inactive
// slots carry no bindings; kind-specific fields are validated without fallback.
type CockpitMeetingTemplateBinding struct {
	SlotID              string  `json:"slot_id"`
	Selected            bool    `json:"selected"`
	NodeID              *string `json:"node_id"`
	FacilitatorUserID   *string `json:"facilitator_user_id"`
	ProjectID           *string `json:"project_id"`
	ModuleID            *string `json:"module_id"`
	AssigneeType        *string `json:"assignee_type"`
	AssigneeID          *string `json:"assignee_id"`
	DueDate             *string `json:"due_date"`
	IssueID             *string `json:"issue_id"`
	MaterialReferenceID *string `json:"material_reference_id"`
}

type CockpitTemplateApplicationPreviewInput struct {
	TemplateVersionID string                          `json:"template_version_id"`
	Bindings          []CockpitMeetingTemplateBinding `json:"bindings"`
}

type CockpitPreparationPreviewEffect struct {
	SlotID       string                           `json:"slot_id"`
	Kind         string                           `json:"kind"`
	Label        string                           `json:"label"`
	AgendaSlotID *string                          `json:"agenda_slot_id"`
	Selected     bool                             `json:"selected"`
	Allowed      bool                             `json:"allowed"`
	ReasonCodes  []string                         `json:"reason_codes"`
	Targets      []IssueOperationTarget           `json:"targets"`
	IssueImpact  *CockpitDispositionIssue         `json:"issue_impact"`
	Scope        *CockpitPreparationResolvedScope `json:"scope"`
}

type CockpitTemplateApplicationPreview struct {
	WorkspaceID       string                            `json:"workspace_id"`
	MeetingID         string                            `json:"meeting_id"`
	TemplateID        string                            `json:"template_id"`
	TemplateVersionID string                            `json:"template_version_id"`
	LifecycleRevision int64                             `json:"lifecycle_revision"`
	AgendaRevision    int64                             `json:"agenda_revision"`
	ContextToken      string                            `json:"context_token"`
	ConfigHash        string                            `json:"config_hash"`
	Effects           []CockpitPreparationPreviewEffect `json:"effects"`
	SelectedTotal     int32                             `json:"selected_total"`
	CanConfirm        bool                              `json:"can_confirm"`
	BlockedReasons    []string                          `json:"blocked_reasons"`
}

type CockpitTemplateApplicationInput struct {
	CockpitLifecycleCommandInput
	CockpitTemplateApplicationPreviewInput
	ContextToken string `json:"context_token"`
}

type CockpitPreparationCounts struct {
	Total          int32 `json:"total"`
	Pending        int32 `json:"pending"`
	Applied        int32 `json:"applied"`
	NeedsAttention int32 `json:"needs_attention"`
	Skipped        int32 `json:"skipped"`
}

type CockpitPreparationOperationHeader struct {
	WorkspaceID           string                   `json:"workspace_id"`
	MeetingID             string                   `json:"meeting_id"`
	ID                    string                   `json:"id"`
	Kind                  string                   `json:"kind"`
	Revision              int64                    `json:"revision"`
	State                 string                   `json:"state"`
	CommandKey            string                   `json:"command_key"`
	TemplateID            *string                  `json:"template_id"`
	TemplateVersionID     *string                  `json:"template_version_id"`
	CreatedBy             string                   `json:"created_by"`
	CreatedByName         string                   `json:"created_by_name"`
	ResponsibleUserID     string                   `json:"responsible_user_id"`
	CreatedAt             string                   `json:"created_at"`
	UpdatedAt             string                   `json:"updated_at"`
	Counts                CockpitPreparationCounts `json:"counts"`
	CanContinue           bool                     `json:"can_continue"`
	CanResume             bool                     `json:"can_resume"`
	CanPause              bool                     `json:"can_pause"`
	CanClaim              bool                     `json:"can_claim"`
	BlockedReasons        []string                 `json:"blocked_reasons"`
	TemplateTitle         string                   `json:"template_title"`
	TemplateVersionNumber *int32                   `json:"template_version_number"`
	ResponsibleUserName   string                   `json:"responsible_user_name"`
}

type CockpitPreparationEffectReceipt struct {
	EffectID              string               `json:"effect_id"`
	CommandKey            string               `json:"command_key"`
	RequestHash           string               `json:"request_hash"`
	Kind                  string               `json:"kind"`
	AgendaID              *string              `json:"agenda_id"`
	ReferenceID           *string              `json:"reference_id"`
	IssueID               *string              `json:"issue_id"`
	RunID                 *string              `json:"run_id"`
	Issue                 *CockpitIssueSummary `json:"issue"`
	RunStatus             *string              `json:"run_status"`
	StoppedWakeupIDs      []string             `json:"stopped_wakeup_ids"`
	CancelledQueueIDs     []string             `json:"cancelled_queue_ids"`
	AppliedAt             string               `json:"applied_at"`
	AuthorizationKey      string               `json:"authorization_key"`
	AuthorizationRevision int64                `json:"authorization_revision"`
	Changed               bool                 `json:"changed"`
	StoppedWakeupTotal    int64                `json:"stopped_wakeup_total"`
	CancelledQueueTotal   int64                `json:"cancelled_queue_total"`
	FactsHash             string               `json:"facts_hash"`
	TargetMeetingID       *string              `json:"target_meeting_id"`
}

type CockpitPreparationEffect struct {
	ID                    string                           `json:"id"`
	OperationID           string                           `json:"operation_id"`
	SlotID                string                           `json:"slot_id"`
	Position              int32                            `json:"position"`
	Kind                  string                           `json:"kind"`
	Label                 string                           `json:"label"`
	Revision              int64                            `json:"revision"`
	State                 string                           `json:"state"`
	CommandKey            string                           `json:"command_key"`
	DependencyID          *string                          `json:"dependency_id"`
	ErrorCode             string                           `json:"error_code"`
	Reason                string                           `json:"reason"`
	Targets               []IssueOperationTarget           `json:"targets"`
	Receipt               *CockpitPreparationEffectReceipt `json:"receipt"`
	CanApply              bool                             `json:"can_apply"`
	CanSkip               bool                             `json:"can_skip"`
	CanReauthorize        bool                             `json:"can_reauthorize"`
	AuthorizationKey      string                           `json:"authorization_key"`
	AuthorizationRevision int64                            `json:"authorization_revision"`
}

type CockpitPreparationEffectPage struct {
	WorkspaceID string                     `json:"workspace_id"`
	MeetingID   string                     `json:"meeting_id"`
	OperationID string                     `json:"operation_id"`
	Revision    int64                      `json:"revision"`
	PageSize    int32                      `json:"page_size"`
	Items       []CockpitPreparationEffect `json:"items"`
	Total       int64                      `json:"total"`
	NextCursor  *string                    `json:"next_cursor"`
}

type CockpitPreparationOperationPage struct {
	WorkspaceID string                              `json:"workspace_id"`
	MeetingID   string                              `json:"meeting_id"`
	PageSize    int32                               `json:"page_size"`
	Items       []CockpitPreparationOperationHeader `json:"items"`
	Total       int64                               `json:"total"`
	NextCursor  *string                             `json:"next_cursor"`
}

// One confirmation authorizes all selected effects. The client automatically
// applies them in order; each request has one transaction and a durable receipt.
type CockpitPreparationEffectApplyInput struct {
	CommandKey            string `json:"command_key"`
	AuthorizationKey      string `json:"authorization_key"`
	AuthorizationRevision int64  `json:"authorization_revision"`
}

type CockpitPreparationControlInput struct {
	CockpitLifecycleCommandInput
	Transition string  `json:"transition"`
	EffectID   *string `json:"effect_id"`
	Reason     string  `json:"reason"`
}

type CockpitPreparationCommandReceipt struct {
	OperationID           string                           `json:"operation_id"`
	Kind                  string                           `json:"kind"`
	Revision              int64                            `json:"revision"`
	State                 string                           `json:"state"`
	EffectIDs             []string                         `json:"effect_ids"`
	EffectID              *string                          `json:"effect_id"`
	Reason                string                           `json:"reason"`
	RequestHash           string                           `json:"request_hash"`
	Occurrence            *CockpitOccurrenceView           `json:"occurrence"`
	ContextToken          string                           `json:"context_token"`
	TemplateVersionID     *string                          `json:"template_version_id"`
	Authorization         *CockpitPreparationAuthorization `json:"authorization"`
	PreviousAuthorization *CockpitPreparationAuthorization `json:"previous_authorization"`
}

type CockpitPreparationCommandResult struct {
	WorkspaceID string                            `json:"workspace_id"`
	MeetingID   string                            `json:"meeting_id"`
	CommandKey  string                            `json:"command_key"`
	Action      string                            `json:"action"`
	Replayed    bool                              `json:"replayed"`
	Receipt     CockpitPreparationCommandReceipt  `json:"receipt"`
	Current     CockpitPreparationOperationHeader `json:"current"`
}

type CockpitPreparationEffectResult struct {
	WorkspaceID string                            `json:"workspace_id"`
	MeetingID   string                            `json:"meeting_id"`
	OperationID string                            `json:"operation_id"`
	EffectID    string                            `json:"effect_id"`
	CommandKey  string                            `json:"command_key"`
	Replayed    bool                              `json:"replayed"`
	Receipt     CockpitPreparationEffectReceipt   `json:"receipt"`
	Current     CockpitPreparationOperationHeader `json:"current"`
}

type CockpitPreparationEffectDetail struct {
	WorkspaceID string                            `json:"workspace_id"`
	MeetingID   string                            `json:"meeting_id"`
	OperationID string                            `json:"operation_id"`
	Effect      CockpitPreparationEffect          `json:"effect"`
	Current     CockpitPreparationOperationHeader `json:"current"`
}

type CockpitPreparationAuthorization struct {
	Key          string                           `json:"key"`
	Revision     int64                            `json:"revision"`
	ContextToken string                           `json:"context_token"`
	FactsHash    string                           `json:"facts_hash"`
	ConfirmedBy  string                           `json:"confirmed_by"`
	ConfirmedAt  string                           `json:"confirmed_at"`
	Impact       *CockpitDispositionIssue         `json:"impact"`
	SelectedRun  *CockpitDispositionRun           `json:"selected_run"`
	Scope        *CockpitPreparationResolvedScope `json:"scope"`
}

type CockpitPreparationReauthorizationPreview struct {
	WorkspaceID           string                           `json:"workspace_id"`
	MeetingID             string                           `json:"meeting_id"`
	OperationID           string                           `json:"operation_id"`
	EffectID              string                           `json:"effect_id"`
	EffectRevision        int64                            `json:"effect_revision"`
	CommandKey            string                           `json:"command_key"`
	FixedIntentHash       string                           `json:"fixed_intent_hash"`
	ContextToken          string                           `json:"context_token"`
	PreviousAuthorization CockpitPreparationAuthorization  `json:"previous_authorization"`
	CurrentImpact         *CockpitDispositionIssue         `json:"current_impact"`
	Targets               []IssueOperationTarget           `json:"targets"`
	CanConfirm            bool                             `json:"can_confirm"`
	BlockedReasons        []string                         `json:"blocked_reasons"`
	CurrentRun            *CockpitDispositionRun           `json:"current_run"`
	CurrentScope          *CockpitPreparationResolvedScope `json:"current_scope"`
}

type CockpitPreparationReauthorizationInput struct {
	CockpitLifecycleCommandInput
	ContextToken string `json:"context_token"`
	Reason       string `json:"reason"`
}

type CockpitPreparationResolvedScope struct {
	NodeID       *string `json:"node_id"`
	NodeTitle    string  `json:"node_title"`
	ProjectID    *string `json:"project_id"`
	ProjectTitle string  `json:"project_title"`
	ModuleID     *string `json:"module_id"`
	ModuleTitle  string  `json:"module_title"`
}
