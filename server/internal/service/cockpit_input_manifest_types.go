package service

const CockpitInputManifestMaxItems = 200

type CockpitInputManifestCounts struct {
	Total               int64 `json:"total"`
	Required            int64 `json:"required"`
	AvailableRequired   int64 `json:"available_required"`
	UnknownRequired     int64 `json:"unknown_required"`
	UnavailableRequired int64 `json:"unavailable_required"`
}
type CockpitInputManifestVersionMetadata struct {
	WorkspaceID   string `json:"workspace_id"`
	IssueID       string `json:"issue_id"`
	ID            string `json:"id"`
	VersionNumber int32  `json:"version_number"`
	CommandKey    string `json:"command_key"`
	ManifestHash  string `json:"manifest_hash"`
	ItemTotal     int64  `json:"item_total"`
	RequiredTotal int64  `json:"required_total"`
	CreatedBy     string `json:"created_by"`
	CreatedByName string `json:"created_by_name"`
	CreatedAt     string `json:"created_at"`
	HasNote       bool   `json:"has_note"`
}
type CockpitInputManifestHeader struct {
	WorkspaceID    string                               `json:"workspace_id"`
	Issue          CockpitIssueSummary                  `json:"issue"`
	Revision       int64                                `json:"revision"` // zero only if no manifest has ever been saved
	CurrentVersion *CockpitInputManifestVersionMetadata `json:"current_version"`
	Counts         CockpitInputManifestCounts           `json:"counts"`
	CanEdit        bool                                 `json:"can_edit"`
	BlockedReasons []string                             `json:"blocked_reasons"`
}
type CockpitInputManifestItem struct {
	Position           int32  `json:"position"` // zero-based and fixed within one version
	InputID            string `json:"input_id"`
	InputTitle         string `json:"input_title"`
	InputVersionID     string `json:"input_version_id"`
	InputVersionNumber int32  `json:"input_version_number"`
	PayloadKind        string `json:"payload_kind"`
	Filename           string `json:"filename"` // immutable safe delivery name, not a source path
	ContentType        string `json:"content_type"`
	SizeBytes          int64  `json:"size_bytes"`
	ContentHash        string `json:"content_hash"`
	Purpose            string `json:"purpose"`
	Required           bool   `json:"required"`
	Availability       string `json:"availability"`
	UnavailableReason  string `json:"unavailable_reason"`
}
type CockpitInputManifestVersionDetail struct {
	CockpitInputManifestVersionMetadata
	Note string `json:"note"`
}
type CockpitInputManifestVersionPage struct {
	WorkspaceID string                                `json:"workspace_id"`
	IssueID     string                                `json:"issue_id"`
	PageSize    int32                                 `json:"page_size"`
	Items       []CockpitInputManifestVersionMetadata `json:"items"`
	Total       int64                                 `json:"total"`
	NextCursor  *string                               `json:"next_cursor"`
}
type CockpitInputManifestItemPage struct {
	WorkspaceID       string                     `json:"workspace_id"`
	IssueID           string                     `json:"issue_id"`
	ManifestVersionID string                     `json:"manifest_version_id"`
	ManifestHash      string                     `json:"manifest_hash"`
	PageSize          int32                      `json:"page_size"`
	Items             []CockpitInputManifestItem `json:"items"`
	Total             int64                      `json:"total"`
	NextCursor        *string                    `json:"next_cursor"`
}
type CockpitInputManifestItemInput struct {
	InputVersionID string `json:"input_version_id"`
	Purpose        string `json:"purpose"`
	Required       bool   `json:"required"`
}
type CockpitInputManifestSaveInput struct {
	CommandKey       string                          `json:"command_key"`
	ExpectedRevision int64                           `json:"expected_revision"`
	Items            []CockpitInputManifestItemInput `json:"items"` // complete ordered selection, <=200, may be empty
	Note             string                          `json:"note"`
}
type CockpitInputManifestReceipt struct {
	CommandKey        string                          `json:"command_key"`
	RequestHash       string                          `json:"request_hash"`
	IssueID           string                          `json:"issue_id"`
	ManifestVersionID string                          `json:"manifest_version_id"`
	VersionNumber     int32                           `json:"version_number"`
	Revision          int64                           `json:"revision"`
	ManifestHash      string                          `json:"manifest_hash"`
	Items             []CockpitInputManifestItemInput `json:"items"`
	Note              string                          `json:"note"`
	CreatedBy         string                          `json:"created_by"`
	CreatedAt         string                          `json:"created_at"`
}
type CockpitInputManifestResult struct {
	WorkspaceID string                      `json:"workspace_id"`
	CommandKey  string                      `json:"command_key"`
	Action      string                      `json:"action"` // input_manifest_save
	Replayed    bool                        `json:"replayed"`
	Receipt     CockpitInputManifestReceipt `json:"receipt"`
	Current     *CockpitInputManifestHeader `json:"current"`
}

// A Run pin records the authorized fixed inputs, never a claim that an Agent
// actually read or used every file. Retries inherit the pointer, not readiness.
type CockpitRunInputManifest struct {
	WorkspaceID      string                               `json:"workspace_id"`
	TaskID           string                               `json:"task_id"`
	IssueID          *string                              `json:"issue_id"`
	ManifestVersion  *CockpitInputManifestVersionMetadata `json:"manifest_version"`
	PreparationState string                               `json:"preparation_state"` // not_recorded | pending | preparing | required_ready | failed
	PreparationHash  *string                              `json:"preparation_hash"`
	PreparedAt       *string                              `json:"prepared_at"`
	ErrorCode        string                               `json:"error_code"`
	Counts           CockpitInputManifestCounts           `json:"counts"`
	RuntimeSupported bool                                 `json:"runtime_supported"`
}

// A preparation acknowledgement comes from the authenticated runtime/task
// claim (task/runtime/dispatched_at). It confirms the exact required byte set, not model comprehension.
type CockpitRunInputPreparationInput struct {
	ManifestVersionID       string   `json:"manifest_version_id"`
	ManifestHash            string   `json:"manifest_hash"`
	DispatchedAt            string   `json:"dispatched_at"`
	State                   string   `json:"state"` // preparing | required_ready | failed
	PreparedInputVersionIDs []string `json:"prepared_input_version_ids"`
	ErrorCode               string   `json:"error_code"`
}
