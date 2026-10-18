package service

import "github.com/jackc/pgx/v5/pgtype"

// Credential identity is populated exclusively by authenticated transport.
// Requests never supply these fields as JSON or turn a machine into Human.
type CockpitDirectoryRead struct {
	WorkspaceID, MeetingID                         pgtype.UUID
	CredentialOwnerID, AgentID, RunID, TaskTokenID pgtype.UUID
	ActorSource                                    string // human | task_token | cloud_pat
}

type CockpitDirectoryQuery struct {
	CockpitDirectoryRead
	RootID, OperationID, StepID, AttemptID pgtype.UUID
	Cursor                                 string
	PageSize                               int32
}

type CockpitDirectoryPrincipal struct {
	Source                string  `json:"source"`
	ActorType             string  `json:"actor_type"`
	ActorID               string  `json:"actor_id"`
	ActorName             string  `json:"actor_name"`
	CredentialOwnerUserID string  `json:"credential_owner_user_id"`
	AuthorizingUserID     string  `json:"authorizing_user_id"`
	AuthorizingUserName   string  `json:"authorizing_user_name"`
	ConfirmedByUserID     *string `json:"confirmed_by_user_id"`
	RunID                 *string `json:"run_id"`
	IssueID               *string `json:"issue_id"`
	AgentID               *string `json:"agent_id"`
	RuntimeID             *string `json:"runtime_id"`
	RelationKind          string  `json:"relation_kind"`
	AgendaReferenceID     *string `json:"agenda_reference_id"`
}

type CockpitDirectoryGrant struct {
	ObservedBinding   CockpitDirectoryBinding   `json:"observed_binding"`
	Kind              string                    `json:"kind"`
	CommandKey        string                    `json:"command_key"`
	Revision          int64                     `json:"revision"`
	ResponsibleUserID string                    `json:"responsible_user_id"`
	Principal         CockpitDirectoryPrincipal `json:"principal"`
	TargetHash        string                    `json:"target_hash"`
	RootConfigHash    string                    `json:"root_config_hash"`
	AcceptedAt        string                    `json:"accepted_at"`
}

type CockpitDirectoryTarget struct {
	RootID            string `json:"root_id"`
	RootPath          string `json:"root_path"`
	PrepareSubpath    string `json:"prepare_subpath"`
	RelativeDirectory string `json:"relative_directory"`
	Directory         string `json:"directory"`
	TargetHash        string `json:"target_hash"`
	RootConfigHash    string `json:"root_config_hash"`
}

type CockpitDirectoryBinding struct {
	NASDir   string `json:"nas_dir"`
	Revision int64  `json:"revision"`
}

type CockpitDirectoryRootMetadata struct {
	RootID              string `json:"root_id"`
	RootPath            string `json:"root_path"`
	PrepareSubpathCount int32  `json:"prepare_subpath_count"`
}

type CockpitDirectoryRootDetail struct {
	WorkspaceID string `json:"workspace_id"`
	CockpitDirectoryRootMetadata
	PrepareSubpaths []string `json:"prepare_subpaths"`
}

type CockpitDirectoryRootPage struct {
	WorkspaceID string                         `json:"workspace_id"`
	PageSize    int32                          `json:"page_size"`
	Items       []CockpitDirectoryRootMetadata `json:"items"`
	Total       int64                          `json:"total"`
	NextCursor  *string                        `json:"next_cursor"`
}

type CockpitDirectoryCapabilities struct {
	Available  bool `json:"available"`
	CanPreview bool `json:"can_preview"`
	CanCreate  bool `json:"can_create"`
}

type CockpitDirectorySummary struct {
	WorkspaceID            string                           `json:"workspace_id"`
	MeetingID              string                           `json:"meeting_id"`
	GeneratedAt            string                           `json:"generated_at"`
	Binding                CockpitDirectoryBinding          `json:"binding"`
	BindingCandidate       *CockpitDirectoryTarget          `json:"binding_candidate"`
	BindingCandidateReason string                           `json:"binding_candidate_reason"`
	Capabilities           CockpitDirectoryCapabilities     `json:"capabilities"`
	BlockedReasons         []string                         `json:"blocked_reasons"`
	Current                *CockpitDirectoryOperationHeader `json:"current"`
	HistoryTotal           int64                            `json:"history_total"`
	UnfinishedTotal        int64                            `json:"unfinished_total"`
	NeedsAttentionTotal    int64                            `json:"needs_attention_total"`
}

type CockpitDirectoryCounts struct {
	Total          int64 `json:"total"`
	Pending        int64 `json:"pending"`
	Running        int64 `json:"running"`
	RetryWait      int64 `json:"retry_wait"`
	Satisfied      int64 `json:"satisfied"`
	NeedsAttention int64 `json:"needs_attention"`
	Abandoned      int64 `json:"abandoned"`
}

type CockpitDirectoryOperationHeader struct {
	WorkspaceID             string                    `json:"workspace_id"`
	MeetingID               string                    `json:"meeting_id"`
	ID                      string                    `json:"id"`
	Revision                int64                     `json:"revision"`
	State                   string                    `json:"state"`
	CommandKey              string                    `json:"command_key"`
	RequestHash             string                    `json:"request_hash"`
	PlanHash                string                    `json:"plan_hash"`
	Target                  CockpitDirectoryTarget    `json:"target"`
	CreatedByType           string                    `json:"created_by_type"`
	CreatedBy               string                    `json:"created_by"`
	CreatedByName           string                    `json:"created_by_name"`
	SourcePrincipal         CockpitDirectoryPrincipal `json:"source_principal"`
	ResponsibleUserID       string                    `json:"responsible_user_id"`
	ResponsibleUserName     string                    `json:"responsible_user_name"`
	LastGrant               CockpitDirectoryGrant     `json:"last_grant"`
	CreatedAt               string                    `json:"created_at"`
	UpdatedAt               string                    `json:"updated_at"`
	FinishedAt              *string                   `json:"finished_at"`
	ObservedBinding         CockpitDirectoryBinding   `json:"observed_binding"`
	AcceptedBindingRevision *int64                    `json:"accepted_binding_revision"`
	BindAfterBase           bool                      `json:"bind_after_base"`
	BindingResult           string                    `json:"binding_result"`
	Counts                  CockpitDirectoryCounts    `json:"counts"`
	CanRetry                bool                      `json:"can_retry"`
	CanPause                bool                      `json:"can_pause"`
	CanResume               bool                      `json:"can_resume"`
	CanClaim                bool                      `json:"can_claim"`
	CanAbandon              bool                      `json:"can_abandon"`
	BlockedReasons          []string                  `json:"blocked_reasons"`
}

type CockpitDirectoryOperationPage struct {
	WorkspaceID string                            `json:"workspace_id"`
	MeetingID   string                            `json:"meeting_id"`
	PageSize    int32                             `json:"page_size"`
	Items       []CockpitDirectoryOperationHeader `json:"items"`
	Total       int64                             `json:"total"`
	NextCursor  *string                           `json:"next_cursor"`
}

type CockpitDirectoryStepMetadata struct {
	ID              string   `json:"id"`
	OperationID     string   `json:"operation_id"`
	Position        int32    `json:"position"`
	Kind            string   `json:"kind"`
	Label           string   `json:"label"`
	RelativePath    string   `json:"relative_path"`
	State           string   `json:"state"`
	Revision        int64    `json:"revision"`
	GrantCommandKey string   `json:"grant_command_key"`
	GrantRevision   int64    `json:"grant_revision"`
	AttemptCount    int32    `json:"attempt_count"`
	LastAttemptID   *string  `json:"last_attempt_id"`
	LastObservedAt  *string  `json:"last_observed_at"`
	Outcome         *string  `json:"outcome"`
	LastErrorCode   string   `json:"last_error_code"`
	CanRetry        bool     `json:"can_retry"`
	BlockedReasons  []string `json:"blocked_reasons"`
}

type CockpitDirectoryStepPage struct {
	WorkspaceID string                         `json:"workspace_id"`
	MeetingID   string                         `json:"meeting_id"`
	OperationID string                         `json:"operation_id"`
	Items       []CockpitDirectoryStepMetadata `json:"items"`
	Total       int64                          `json:"total"`
	Counts      CockpitDirectoryCounts         `json:"counts"`
}

type CockpitDirectoryAttemptMetadata struct {
	ID            string  `json:"id"`
	StepID        string  `json:"step_id"`
	AttemptNumber int32   `json:"attempt_number"`
	State         string  `json:"state"`
	StartedAt     string  `json:"started_at"`
	FinishedAt    *string `json:"finished_at"`
	ErrorCode     string  `json:"error_code"`
	Outcome       *string `json:"outcome"`
	ObservedAt    *string `json:"observed_at"`
}

type CockpitDirectoryObservation struct {
	Directory         string `json:"directory"`
	DirectoryIdentity string `json:"directory_identity"`
	RootIdentity      string `json:"root_identity"`
	Outcome           string `json:"outcome"`
	ObservedAt        string `json:"observed_at"`
}

type CockpitDirectoryAttemptDetail struct {
	WorkspaceID string `json:"workspace_id"`
	MeetingID   string `json:"meeting_id"`
	OperationID string `json:"operation_id"`
	CockpitDirectoryAttemptMetadata
	GrantCommandKey string                       `json:"grant_command_key"`
	GrantRevision   int64                        `json:"grant_revision"`
	ErrorMessage    string                       `json:"error_message"`
	Receipt         *CockpitDirectoryObservation `json:"receipt"`
	LateReceipt     *CockpitDirectoryObservation `json:"late_receipt"`
	LateObservedAt  *string                      `json:"late_observed_at"`
}

type CockpitDirectoryAttemptPage struct {
	WorkspaceID string                            `json:"workspace_id"`
	MeetingID   string                            `json:"meeting_id"`
	OperationID string                            `json:"operation_id"`
	StepID      string                            `json:"step_id"`
	PageSize    int32                             `json:"page_size"`
	Items       []CockpitDirectoryAttemptMetadata `json:"items"`
	Total       int64                             `json:"total"`
	NextCursor  *string                           `json:"next_cursor"`
}

type CockpitDirectoryPreviewInput struct {
	Mode                    string   `json:"mode"`
	RootID                  string   `json:"root_id"`
	RelativeDirectory       string   `json:"relative_directory"`
	Partitions              []string `json:"partitions"`
	ObservedNASDir          string   `json:"observed_nas_dir"`
	ObservedBindingRevision int64    `json:"observed_binding_revision"`
	BindAfterBase           bool     `json:"bind_after_base"`
}

type CockpitDirectoryPreviewStep struct {
	StepID         *string `json:"step_id"`
	Position       int32   `json:"position"`
	ParentPosition *int32  `json:"parent_position"`
	Kind           string  `json:"kind"`
	Label          string  `json:"label"`
	RelativePath   string  `json:"relative_path"`
	PathHash       string  `json:"path_hash"`
	PlannedState   string  `json:"planned_state"`
	ErrorCode      string  `json:"error_code"`
}

type CockpitDirectoryPreviewCounts struct {
	Total    int32 `json:"total"`
	Exists   int32 `json:"exists"`
	Missing  int32 `json:"missing"`
	Conflict int32 `json:"conflict"`
	Unknown  int32 `json:"unknown"`
}

type CockpitDirectoryPreview struct {
	WorkspaceID     string                        `json:"workspace_id"`
	MeetingID       string                        `json:"meeting_id"`
	Target          CockpitDirectoryTarget        `json:"target"`
	PlanHash        string                        `json:"plan_hash"`
	ObservedBinding CockpitDirectoryBinding       `json:"observed_binding"`
	BindAfterBase   bool                          `json:"bind_after_base"`
	Steps           []CockpitDirectoryPreviewStep `json:"steps"`
	Counts          CockpitDirectoryPreviewCounts `json:"counts"`
	ContextToken    string                        `json:"context_token"`
	CanConfirm      bool                          `json:"can_confirm"`
	BlockedReasons  []string                      `json:"blocked_reasons"`
	CheckedAt       string                        `json:"checked_at"`
	Principal       *CockpitDirectoryPrincipal    `json:"principal"`
}

type CockpitDirectoryCreateInput struct {
	CockpitDirectoryPreviewInput
	CommandKey       string `json:"command_key"`
	ExpectedRevision int64  `json:"expected_revision"`
	ContextToken     string `json:"context_token"`
}

type CockpitDirectoryRetryPreviewInput struct {
	StepIDs []string `json:"step_ids"`
}

type CockpitDirectoryRetryPreview struct {
	CockpitDirectoryPreview
	OperationID       string   `json:"operation_id"`
	OperationRevision int64    `json:"operation_revision"`
	StepIDs           []string `json:"step_ids"`
}

type CockpitDirectoryRetryInput struct {
	CommandKey       string   `json:"command_key"`
	ExpectedRevision int64    `json:"expected_revision"`
	StepIDs          []string `json:"step_ids"`
	ContextToken     string   `json:"context_token"`
	Reason           string   `json:"reason"`
}

type CockpitDirectoryControlInput struct {
	CommandKey       string `json:"command_key"`
	ExpectedRevision int64  `json:"expected_revision"`
	Transition       string `json:"transition"`
	Reason           string `json:"reason"`
}

type CockpitDirectoryCommandReceipt struct {
	DirectoryOperationID string                    `json:"directory_operation_id"`
	DirectoryStepIDs     []string                  `json:"directory_step_ids"`
	RequestHash          string                    `json:"request_hash"`
	ContextToken         *string                   `json:"context_token"`
	PlanHash             string                    `json:"plan_hash"`
	Target               CockpitDirectoryTarget    `json:"target"`
	ObservedBinding      CockpitDirectoryBinding   `json:"observed_binding"`
	BindAfterBase        bool                      `json:"bind_after_base"`
	OperationRevision    int64                     `json:"operation_revision"`
	State                string                    `json:"state"`
	ResponsibleUserID    string                    `json:"responsible_user_id"`
	AuthorizedAt         string                    `json:"authorized_at"`
	Reason               string                    `json:"reason"`
	Principal            CockpitDirectoryPrincipal `json:"principal"`
	Grant                CockpitDirectoryGrant     `json:"grant"`
}

type CockpitDirectoryCommandResult struct {
	WorkspaceID string                          `json:"workspace_id"`
	MeetingID   string                          `json:"meeting_id"`
	CommandKey  string                          `json:"command_key"`
	Action      string                          `json:"action"`
	Replayed    bool                            `json:"replayed"`
	Receipt     CockpitDirectoryCommandReceipt  `json:"receipt"`
	Current     CockpitDirectoryOperationHeader `json:"current"`
}

// Legacy transport supplies its resolved absolute directory proposal. The
// service still resolves it against prepare_subpaths and records the plan.
type CockpitLegacyDirectoryInput struct {
	Directory string
}

type CockpitLegacyDirectoryResult struct {
	OperationID  string
	State        string
	Directory    string
	BaseReady    bool
	ErrorCode    string
	ErrorMessage string
}
