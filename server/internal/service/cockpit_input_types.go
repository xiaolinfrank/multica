package service

import "github.com/jackc/pgx/v5/pgtype"

// N2 wire contract. Capabilities remain disabled until the full implementation
// and agent3 acceptance are complete. These declarations do not register routes.
const (
	CockpitInputPageSize                  = 25
	CockpitInputMaxPageSize               = 100
	CockpitInputMaxSelectedIDs            = 100
	CockpitInputMaxFileBytes        int64 = 500 << 20
	CockpitInputMaxTitleBytes             = 512
	CockpitInputMaxDescriptionBytes       = 16000
	CockpitInputMaxFilenameBytes          = 255
)

// Only authenticated transport supplies this identity. No JSON body may supply
// actor, originator, credential owner, Agent, task token, or Run identity.
type CockpitInputRead struct {
	TrustedDaemonID                                             string // authenticated MDT identity only; absent for ordinary cloud credentials
	RuntimeID                                                   pgtype.UUID
	ClaimDispatchedAt                                           pgtype.Timestamptz // exact existing task/runtime/dispatched_at claim; daemon reads/ACK only
	WorkspaceID, CredentialOwnerID, AgentID, RunID, TaskTokenID pgtype.UUID
	ActorSource                                                 string // human | task_token | cloud_pat | daemon_claim
}
type CockpitInputQuery struct {
	Purpose string
	CockpitInputRead
	InputID, VersionID, TransferID, ReferenceID, MeetingID, AgendaID, IssueID pgtype.UUID
	CommandKey, ManifestVersionID, TaskID                                     pgtype.UUID
	Cursor                                                                    string
	PageSize                                                                  int32
	Scope                                                                     CockpitInputScope
	IncludeRemoved                                                            bool
}
type CockpitInputPrincipal struct {
	ActorType             string  `json:"actor_type"`
	ActorID               string  `json:"actor_id"`
	ActorName             string  `json:"actor_name"`
	CredentialOwnerUserID string  `json:"credential_owner_user_id"`
	AuthorizingUserID     string  `json:"authorizing_user_id"`
	AuthorizingUserName   string  `json:"authorizing_user_name"`
	AgentID               *string `json:"agent_id"`
	RunID                 *string `json:"run_id"`
	IssueID               *string `json:"issue_id"`
	RuntimeID             *string `json:"runtime_id"`
}
type CockpitInputScope struct {
	IDs           []string `json:"ids"`
	ProjectID     *string  `json:"project_id"`
	MeetingID     *string  `json:"meeting_id"`
	AgendaID      *string  `json:"agenda_id"`
	OriginIssueID *string  `json:"origin_issue_id"`
	Query         string   `json:"q"`
	Archive       string   `json:"archive"`     // active | archived | all; default active
	SourceKind    string   `json:"source_kind"` // empty or an exact supported source kind
}
type CockpitInputCapabilities struct {
	WorkspaceID             string `json:"workspace_id"`
	CanCreate               bool   `json:"can_create"`
	CanBrowseNAS            bool   `json:"can_browse_nas"`
	DirectUploadAvailable   bool   `json:"direct_upload_available"`
	FileCaptureAvailable    bool   `json:"file_capture_available"`
	UnavailableReason       string `json:"unavailable_reason"`
	MaxFileBytes            int64  `json:"max_file_bytes"`
	UploadSessionTTLSeconds int64  `json:"upload_session_ttl_seconds"`
}
type CockpitInputHeader struct {
	WorkspaceID    string                       `json:"workspace_id"`
	ID             string                       `json:"id"`
	CreationKey    string                       `json:"creation_key"`
	Title          string                       `json:"title"`
	Description    string                       `json:"description"`
	ProjectID      *string                      `json:"project_id"`
	OriginIssue    *CockpitIssueSummary         `json:"origin_issue"`
	Revision       int64                        `json:"revision"`
	RegisteredBy   CockpitInputPrincipal        `json:"registered_by"`
	CreatedAt      string                       `json:"created_at"`
	UpdatedAt      string                       `json:"updated_at"`
	ArchivedAt     *string                      `json:"archived_at"`
	CurrentVersion *CockpitInputVersionMetadata `json:"current_version"`
	VersionTotal   int64                        `json:"version_total"`
	ReferenceTotal int64                        `json:"reference_total"`
	CanEdit        bool                         `json:"can_edit"`
	CanSubmit      bool                         `json:"can_submit"`
	CanArchive     bool                         `json:"can_archive"`
	CanUnarchive   bool                         `json:"can_unarchive"`
	BlockedReasons []string                     `json:"blocked_reasons"`
}
type CockpitInputPage struct {
	WorkspaceID string               `json:"workspace_id"`
	Scope       CockpitInputScope    `json:"scope"`
	PageSize    int32                `json:"page_size"`
	Items       []CockpitInputHeader `json:"items"`
	Total       int64                `json:"total"`
	NextCursor  *string              `json:"next_cursor"`
	CanCreate   bool                 `json:"can_create"`
}
type CockpitInputCreateInput struct {
	CommandKey    string  `json:"command_key"`
	Title         string  `json:"title"`
	Description   string  `json:"description"`
	ProjectID     *string `json:"project_id"`
	OriginIssueID *string `json:"origin_issue_id"`
}
type CockpitInputCreateReceipt struct {
	InputRevision int64                 `json:"input_revision"` // fixed creation revision, always one
	CommandKey    string                `json:"command_key"`
	RequestHash   string                `json:"request_hash"`
	InputID       string                `json:"input_id"`
	Title         string                `json:"title"`
	Description   string                `json:"description"`
	ProjectID     *string               `json:"project_id"`
	OriginIssueID *string               `json:"origin_issue_id"`
	Principal     CockpitInputPrincipal `json:"principal"`
	CreatedAt     string                `json:"created_at"`
}
type CockpitInputCreateResult struct {
	WorkspaceID string                    `json:"workspace_id"`
	CommandKey  string                    `json:"command_key"`
	Action      string                    `json:"action"` // input_create
	Replayed    bool                      `json:"replayed"`
	Receipt     CockpitInputCreateReceipt `json:"receipt"`
	Current     *CockpitInputHeader       `json:"current"`
}

// Reversible metadata uses revision compare-and-swap, not a durable command.
// Unknown responses require a reload; never clear an unconfirmed client draft.
type CockpitInputEditInput struct {
	ExpectedRevision int64  `json:"expected_revision"`
	Title            string `json:"title"`
	Description      string `json:"description"`
}
type CockpitInputArchiveInput struct {
	ExpectedRevision int64 `json:"expected_revision"`
	Archived         bool  `json:"archived"`
}

type CockpitInputUploadSource struct {
	Filename     string  `json:"filename"`
	ContentType  string  `json:"content_type"`
	SizeBytes    *int64  `json:"size_bytes"` // required numeric field; pointer distinguishes absent/null from an empty file
	ClientSHA256 *string `json:"client_sha256"`
}
type CockpitInputNASSource struct {
	RootID           string `json:"root_id"`
	RelativePath     string `json:"relative_path"`
	ObservationToken string `json:"observation_token"`
}
type CockpitInputAttachmentSource struct {
	IssueID      string `json:"issue_id"`
	AttachmentID string `json:"attachment_id"`
}
type CockpitInputArtifactSource struct {
	ArtifactID string `json:"artifact_id"`
	VersionID  string `json:"version_id"`
}

// Exactly one branch must match Kind; unknown kinds and extra branches reject.
type CockpitInputSourceInput struct {
	Kind            string                        `json:"kind"` // upload | nas_file | attachment | artifact_version
	Upload          *CockpitInputUploadSource     `json:"upload,omitempty"`
	NASFile         *CockpitInputNASSource        `json:"nas_file,omitempty"`
	Attachment      *CockpitInputAttachmentSource `json:"attachment,omitempty"`
	ArtifactVersion *CockpitInputArtifactSource   `json:"artifact_version,omitempty"`
}
type CockpitInputSourceMetadata struct {
	Kind                    string               `json:"kind"`
	Issue                   *CockpitIssueSummary `json:"issue"`
	AttachmentID            *string              `json:"attachment_id"`
	RootID                  *string              `json:"root_id"`
	RelativePath            *string              `json:"relative_path"`
	ArtifactID              *string              `json:"artifact_id"`
	ArtifactTitle           string               `json:"artifact_title"`
	ArtifactVersionID       *string              `json:"artifact_version_id"`
	ArtifactVersionNumber   *int32               `json:"artifact_version_number"`
	ArtifactDecision        *string              `json:"artifact_decision"`
	SourceAvailable         bool                 `json:"source_available"`
	SourceUnavailableReason string               `json:"source_unavailable_reason"`
}
type CockpitInputVersionMetadata struct {
	LatestTransferID    *string                    `json:"latest_transfer_id"`    // newest attempt, including failed/expired; exact metadata projection
	AllowedRestartModes []string                   `json:"allowed_restart_modes"` // only authorized retry_source/upload_matching_bytes, not guessed from state
	CurrentTransferID   *string                    `json:"current_transfer_id"`   // current verified owned copy; first accepted transfer remains fixed
	WorkspaceID         string                     `json:"workspace_id"`
	InputID             string                     `json:"input_id"`
	ID                  string                     `json:"id"`
	VersionNumber       int32                      `json:"version_number"`
	SubmissionKey       string                     `json:"submission_key"`
	Revision            int64                      `json:"revision"`
	PayloadKind         string                     `json:"payload_kind"` // file | text
	Source              CockpitInputSourceMetadata `json:"source"`
	SubmittedBy         CockpitInputPrincipal      `json:"submitted_by"`
	Filename            string                     `json:"filename"`
	ContentType         string                     `json:"content_type"`
	DeclaredSizeBytes   *int64                     `json:"declared_size_bytes"`
	SizeBytes           *int64                     `json:"size_bytes"`
	ContentHash         *string                    `json:"content_hash"`
	CaptureState        string                     `json:"capture_state"` // awaiting_upload | queued | capturing | ready | needs_attention
	CaptureErrorCode    string                     `json:"capture_error_code"`
	Availability        string                     `json:"availability"` // unknown | checking | available | unavailable
	CheckedAt           *string                    `json:"checked_at"`
	UnavailableReason   string                     `json:"unavailable_reason"`
	ActiveTransferID    *string                    `json:"active_transfer_id"`
	AcceptedTransferID  *string                    `json:"accepted_transfer_id"`
	CreatedAt           string                     `json:"created_at"`
	ReadyAt             *string                    `json:"ready_at"`
	CanDownload         bool                       `json:"can_download"`
	CanRestart          bool                       `json:"can_restart"`
	CanReference        bool                       `json:"can_reference"`
	CanVerify           bool                       `json:"can_verify"`
	BlockedReasons      []string                   `json:"blocked_reasons"`
}
type CockpitInputVersionDetail struct {
	WorkspaceID  string                      `json:"workspace_id"`
	InputID      string                      `json:"input_id"`
	Version      CockpitInputVersionMetadata `json:"version"`
	Content      *string                     `json:"content"` // exact text only; file content uses a verified stream
	CaptureError string                      `json:"capture_error"`
}
type CockpitInputVersionPage struct {
	WorkspaceID string                        `json:"workspace_id"`
	InputID     string                        `json:"input_id"`
	PageSize    int32                         `json:"page_size"`
	Items       []CockpitInputVersionMetadata `json:"items"`
	Total       int64                         `json:"total"`
	NextCursor  *string                       `json:"next_cursor"`
}
type CockpitInputInitialReference struct {
	ReferenceKey string  `json:"reference_key"`
	MeetingID    string  `json:"meeting_id"`
	AgendaID     *string `json:"agenda_id"`
	Purpose      string  `json:"purpose"` // material | recording | supporting
}
type CockpitInputVersionSubmitInput struct {
	CommandKey       string                        `json:"command_key"`
	ExpectedRevision int64                         `json:"expected_revision"` // input header revision
	Source           CockpitInputSourceInput       `json:"source"`
	InitialReference *CockpitInputInitialReference `json:"initial_reference"`
}
type CockpitInputVersionReceipt struct {
	TransferRevision *int64                        `json:"transfer_revision"` // fixed first-transfer revision; null for borrowed artifact content
	CommandKey       string                        `json:"command_key"`
	RequestHash      string                        `json:"request_hash"`
	InputID          string                        `json:"input_id"`
	VersionID        string                        `json:"version_id"`
	VersionNumber    int32                         `json:"version_number"`
	InputRevision    int64                         `json:"input_revision"`
	Source           CockpitInputSourceInput       `json:"source"`
	PayloadKind      string                        `json:"payload_kind"`
	CaptureState     string                        `json:"capture_state"`
	TransferID       *string                       `json:"transfer_id"`
	InitialReference *CockpitInputReferenceReceipt `json:"initial_reference"`
	Principal        CockpitInputPrincipal         `json:"principal"`
	AcceptedAt       string                        `json:"accepted_at"`
}
type CockpitInputVersionResult struct {
	WorkspaceID string                        `json:"workspace_id"`
	InputID     string                        `json:"input_id"`
	CommandKey  string                        `json:"command_key"`
	Action      string                        `json:"action"` // input_version_submit
	Replayed    bool                          `json:"replayed"`
	Receipt     CockpitInputVersionReceipt    `json:"receipt"`
	Current     *CockpitInputVersionMetadata  `json:"current"`
	Transfer    *CockpitInputTransferMetadata `json:"transfer"`
}

type CockpitInputTransferMetadata struct {
	Mode             string                `json:"mode"` // initial | retry_source | upload_matching_bytes
	WorkspaceID      string                `json:"workspace_id"`
	InputID          string                `json:"input_id"`
	VersionID        string                `json:"version_id"`
	ID               string                `json:"id"`
	TransferNumber   int32                 `json:"transfer_number"`
	CommandKey       string                `json:"command_key"`
	Kind             string                `json:"kind"`  // direct_upload | source_capture
	State            string                `json:"state"` // see the frozen state list in the runtime contract
	Revision         int64                 `json:"revision"`
	Principal        CockpitInputPrincipal `json:"principal"`
	ReceivedBytes    *int64                `json:"received_bytes"`
	ExpectedBytes    int64                 `json:"expected_bytes"`
	PinnedSizeBytes  *int64                `json:"pinned_size_bytes"`
	ContentHash      *string               `json:"content_hash"`
	SessionExpiresAt *string               `json:"session_expires_at"`
	LeaseExpiresAt   *string               `json:"lease_expires_at"`
	CreatedAt        string                `json:"created_at"`
	FinishedAt       *string               `json:"finished_at"`
	ErrorCode        string                `json:"error_code"`
	CanUpload        bool                  `json:"can_upload"`
	CanRestart       bool                  `json:"can_restart"`
	CanFinalize      bool                  `json:"can_finalize"`
	CanAbandon       bool                  `json:"can_abandon"`
	BlockedReasons   []string              `json:"blocked_reasons"`
}
type CockpitInputTransferDetail struct {
	CockpitInputTransferMetadata
	ErrorMessage string `json:"error_message"`
}
type CockpitInputTransferPage struct {
	WorkspaceID string                         `json:"workspace_id"`
	InputID     string                         `json:"input_id"`
	VersionID   string                         `json:"version_id"`
	PageSize    int32                          `json:"page_size"`
	Items       []CockpitInputTransferMetadata `json:"items"`
	Total       int64                          `json:"total"`
	NextCursor  *string                        `json:"next_cursor"`
}
type CockpitInputRestartInput struct {
	Mode               string  `json:"mode"` // retry_source | upload_matching_bytes
	CommandKey         string  `json:"command_key"`
	ExpectedRevision   int64   `json:"expected_revision"` // version revision
	PreviousTransferID *string `json:"previous_transfer_id"`
	Reason             string  `json:"reason"` // optional; UTF-8 <=16000 bytes
}
type CockpitInputFinalizeInput struct {
	CommandKey          string `json:"command_key"`
	ExpectedRevision    int64  `json:"expected_revision"` // transfer revision
	ExpectedContentHash string `json:"expected_content_hash"`
}
type CockpitInputAbandonInput struct {
	CommandKey       string `json:"command_key"`
	ExpectedRevision int64  `json:"expected_revision"`
	Reason           string `json:"reason"`
}
type CockpitInputTransferReceipt struct {
	Mode               string                `json:"mode"` // the fixed original restart intent
	CommandKey         string                `json:"command_key"`
	RequestHash        string                `json:"request_hash"`
	Action             string                `json:"action"` // input_transfer_restart | input_transfer_finalize | input_transfer_abandon
	InputID            string                `json:"input_id"`
	VersionID          string                `json:"version_id"`
	TransferID         string                `json:"transfer_id"`
	TransferNumber     int32                 `json:"transfer_number"`
	ReplacesTransferID *string               `json:"replaces_transfer_id"`
	BeforeRevision     int64                 `json:"before_revision"`
	Revision           int64                 `json:"revision"`
	State              string                `json:"state"`
	SizeBytes          *int64                `json:"size_bytes"`
	ContentHash        *string               `json:"content_hash"`
	Reason             string                `json:"reason"`
	Principal          CockpitInputPrincipal `json:"principal"`
	AcceptedAt         string                `json:"accepted_at"`
}
type CockpitInputTransferResult struct {
	WorkspaceID string                        `json:"workspace_id"`
	InputID     string                        `json:"input_id"`
	VersionID   string                        `json:"version_id"`
	CommandKey  string                        `json:"command_key"`
	Action      string                        `json:"action"`
	Replayed    bool                          `json:"replayed"`
	Receipt     CockpitInputTransferReceipt   `json:"receipt"`
	Current     *CockpitInputTransferMetadata `json:"current"`
	Version     *CockpitInputVersionMetadata  `json:"version"`
}
type CockpitInputUploadResult struct {
	WorkspaceID string                        `json:"workspace_id"`
	InputID     string                        `json:"input_id"`
	VersionID   string                        `json:"version_id"`
	TransferID  string                        `json:"transfer_id"`
	Current     *CockpitInputTransferMetadata `json:"current"`
}

type CockpitInputReference struct {
	WorkspaceID  string                      `json:"workspace_id"`
	ID           string                      `json:"id"`
	ReferenceKey string                      `json:"reference_key"`
	MeetingID    string                      `json:"meeting_id"`
	MeetingTitle string                      `json:"meeting_title"`
	AgendaID     *string                     `json:"agenda_id"`
	AgendaTitle  string                      `json:"agenda_title"`
	InputID      string                      `json:"input_id"`
	InputTitle   string                      `json:"input_title"`
	Version      CockpitInputVersionMetadata `json:"version"`
	Purpose      string                      `json:"purpose"`
	CreatedBy    CockpitInputPrincipal       `json:"created_by"`
	CreatedAt    string                      `json:"created_at"`
	RemovedAt    *string                     `json:"removed_at"`
	CanRemove    bool                        `json:"can_remove"`
}
type CockpitInputReferenceSummary struct {
	AvailableReady   int64 `json:"available_ready"`
	UnavailableReady int64 `json:"unavailable_ready"`
	UnknownReady     int64 `json:"unknown_ready"`
	Total            int64 `json:"total"`
	Ready            int64 `json:"ready"`
	Pending          int64 `json:"pending"`
	NeedsAttention   int64 `json:"needs_attention"`
}
type CockpitInputReferencePage struct {
	Query          string                       `json:"q"`
	Purpose        string                       `json:"purpose"`
	WorkspaceID    string                       `json:"workspace_id"`
	MeetingID      string                       `json:"meeting_id"`
	AgendaID       *string                      `json:"agenda_id"`
	IncludeRemoved bool                         `json:"include_removed"`
	PageSize       int32                        `json:"page_size"`
	Items          []CockpitInputReference      `json:"items"`
	Total          int64                        `json:"total"`
	Summary        CockpitInputReferenceSummary `json:"summary"` // all active references in this exact scope, independent of page
	NextCursor     *string                      `json:"next_cursor"`
	CanAdd         bool                         `json:"can_add"`
	BlockedReasons []string                     `json:"blocked_reasons"`
}
type CockpitInputReferenceCreateInput struct {
	CommandKey     string  `json:"command_key"`
	AgendaID       *string `json:"agenda_id"`
	InputVersionID string  `json:"input_version_id"`
	Purpose        string  `json:"purpose"`
}
type CockpitInputReferenceRemoveInput struct {
	CommandKey string `json:"command_key"`
}
type CockpitInputReferenceReceipt struct {
	CommandKey     string                `json:"command_key"`
	RequestHash    string                `json:"request_hash"`
	ReferenceID    string                `json:"reference_id"`
	MeetingID      string                `json:"meeting_id"`
	AgendaID       *string               `json:"agenda_id"`
	InputID        string                `json:"input_id"`
	InputVersionID string                `json:"input_version_id"`
	Purpose        string                `json:"purpose"`
	Removed        bool                  `json:"removed"`
	Principal      CockpitInputPrincipal `json:"principal"`
	AcceptedAt     string                `json:"accepted_at"`
}
type CockpitInputReferenceResult struct {
	WorkspaceID string                       `json:"workspace_id"`
	CommandKey  string                       `json:"command_key"`
	Action      string                       `json:"action"` // input_reference_create | input_reference_remove
	Replayed    bool                         `json:"replayed"`
	Receipt     CockpitInputReferenceReceipt `json:"receipt"`
	Current     *CockpitInputReference       `json:"current"`
}
type CockpitInputDownloadLink struct {
	WorkspaceID string `json:"workspace_id"`
	InputID     string `json:"input_id"`
	VersionID   string `json:"version_id"`
	ContentHash string `json:"content_hash"`
	SizeBytes   int64  `json:"size_bytes"`
	URL         string `json:"url"`
	ExpiresAt   string `json:"expires_at"`
}

// Selected historical versions are restored in bounded batches, not via the
// current input header or one request per version. Missing and unauthorized
// identities share unavailable_ids; a database failure is not an empty result.
type CockpitInputVersionBatch struct {
	WorkspaceID    string                        `json:"workspace_id"`
	RequestedIDs   []string                      `json:"requested_ids"`
	Items          []CockpitInputVersionMetadata `json:"items"`
	UnavailableIDs []string                      `json:"unavailable_ids"`
}
