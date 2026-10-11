package service

import "github.com/jackc/pgx/v5/pgtype"

// Operation basis is a read projection, never a substitute for transactional guards.
type IssueOperationField struct {
	State       string   `json:"state"`
	ReasonCodes []string `json:"reason_codes"`
}
type IssueStatusOperationField struct {
	IssueOperationField
	AllowedCategories []string `json:"allowed_categories"`
}
type IssueOperationTarget struct {
	Kind        string `json:"kind"`
	IssueID     string `json:"issue_id,omitempty"`
	NodeID      string `json:"node_id,omitempty"`
	MeetingID   string `json:"meeting_id,omitempty"`
	ActionID    string `json:"action_id,omitempty"`
	ArtifactID  string `json:"artifact_id,omitempty"`
	VersionID   string `json:"version_id,omitempty"`
	RequestID   string `json:"request_id,omitempty"`
	OperationID string `json:"operation_id,omitempty"`
	View        string `json:"view,omitempty"`
	Label       string `json:"label"`
	Purpose     string `json:"purpose"`
}
type IssueOperationBasis struct {
	IssueID       string                    `json:"issue_id"`
	Availability  string                    `json:"availability"`
	IssueRevision *int64                    `json:"issue_revision"`
	Status        IssueStatusOperationField `json:"status"`
	Assignee      IssueOperationField       `json:"assignee"`
	Scope         IssueOperationField       `json:"scope"`
	Parent        IssueOperationField       `json:"parent"`
	Primary       IssueOperationField       `json:"primary"`
	Delete        IssueOperationField       `json:"delete"`
	Execution     IssueOperationField       `json:"execution"`
	Targets       []IssueOperationTarget    `json:"targets"`
	TargetsTotal  int64                     `json:"targets_total"`
}
type IssueOperationBasisPage struct {
	WorkspaceID   string                `json:"workspace_id"`
	SchemaVersion int                   `json:"schema_version"`
	GeneratedAt   string                `json:"generated_at"`
	Items         []IssueOperationBasis `json:"items"`
}
type IssueOperationBasisQuery struct {
	WorkspaceID, ActorID pgtype.UUID
	Human                bool
	IssueIDs             []pgtype.UUID
}

// Container fields are always present, including unavailable/unknown responses.
// structural_edit and add_child apply to nodes; project/module report unknown/not_applicable.
type ContainerOperationBasis struct {
	WorkspaceID      string                 `json:"workspace_id"`
	SchemaVersion    int                    `json:"schema_version"`
	GeneratedAt      string                 `json:"generated_at"`
	ResourceKind     string                 `json:"resource_kind"`
	ResourceID       string                 `json:"resource_id"`
	Availability     string                 `json:"availability"`
	ResourceRevision *int64                 `json:"resource_revision"`
	Delete           IssueOperationField    `json:"delete"`
	StructuralEdit   IssueOperationField    `json:"structural_edit"`
	AddChild         IssueOperationField    `json:"add_child"`
	Targets          []IssueOperationTarget `json:"targets"`
	TargetsTotal     int64                  `json:"targets_total"`
}
type ContainerOperationBasisQuery struct {
	WorkspaceID, ActorID, ResourceID pgtype.UUID
	Human                            bool
	ResourceKind                     string
}

// Batch receipts preserve the endpoint's existing HTTP status and transaction mode.
// Each requested ID occurs exactly once in Results or UnconfirmedIDs.
type IssueBatchResult struct {
	IssueID  string `json:"issue_id"`
	Outcome  string `json:"outcome"`
	Revision *int64 `json:"revision,omitempty"`
	Changed  *bool  `json:"changed,omitempty"`
	Code     string `json:"code,omitempty"`
}
type IssueBatchReceipt struct {
	WorkspaceID        string             `json:"workspace_id"`
	RequestedIDs       []string           `json:"requested_ids"`
	TransactionMode    string             `json:"transaction_mode"`
	TransactionOutcome string             `json:"transaction_outcome"`
	Results            []IssueBatchResult `json:"results"`
	UnconfirmedIDs     []string           `json:"unconfirmed_ids"`
}
