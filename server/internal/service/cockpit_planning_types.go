package service

import "github.com/jackc/pgx/v5/pgtype"

type CockpitActionDraft struct {
	WorkspaceID, MeetingID, VersionID, ActorID, ProposalKey pgtype.UUID
	Title, Description, SourceQuote                         string
}
type CockpitActionEdit struct {
	WorkspaceID, MeetingID, ActionID, ActorID pgtype.UUID
	ExpectedRevision                          int64
	Title, Description, SourceQuote           string
}
type CockpitActionResolution struct {
	WorkspaceID, MeetingID, ActionID, ActorID, DecisionKey, NodeID, IssueID pgtype.UUID
	ExpectedRevision                                                        int64
	Outcome, Reason                                                         string
	NewIssue                                                                IssueCreateParams
}
type CockpitNodeTaskCreate struct {
	WorkspaceID, NodeID, ActorID, CreationKey pgtype.UUID
	NewIssue                                  IssueCreateParams
}
type CockpitPrimaryNodeCommand struct {
	WorkspaceID, IssueID, NodeID, ActorID pgtype.UUID
	ExpectedRevision                      int64
}
type CockpitActionList struct {
	WorkspaceID, MeetingID, ActorID, VersionID pgtype.UUID
	Human                                      bool
	Query, Status, Cursor                      string
	PageSize                                   int32
}
type CockpitActionRead struct {
	WorkspaceID, MeetingID, ActionID, ActorID pgtype.UUID
	Human                                     bool
}
type CockpitNodeTaskList struct {
	WorkspaceID, NodeID                       pgtype.UUID
	Query, Status, Category, Relation, Cursor string
	PageSize                                  int32
}

type CockpitIssueSummary struct {
	ID              string  `json:"id"`
	Identifier      string  `json:"identifier"`
	Title           string  `json:"title"`
	Status          string  `json:"status"`
	StatusCategory  string  `json:"status_category"`
	Priority        string  `json:"priority"`
	AssigneeType    *string `json:"assignee_type"`
	AssigneeID      *string `json:"assignee_id"`
	AssigneeName    string  `json:"assignee_name"`
	DueDate         *string `json:"due_date"`
	ProjectID       *string `json:"project_id"`
	ModuleID        *string `json:"module_id"`
	PrimaryNodeID   *string `json:"primary_node_id"`
	PrimaryNodeCode string  `json:"primary_node_code"`
	PrimaryNodeName string  `json:"primary_node_name"`
	PrimaryRevision int64   `json:"primary_revision"`
	CreationKey     *string `json:"creation_key"`
}
type CockpitPrimaryView struct {
	IssueID   string  `json:"issue_id"`
	NodeID    *string `json:"node_id"`
	NodeCode  string  `json:"node_code"`
	NodeName  string  `json:"node_name"`
	Revision  int64   `json:"revision"`
	ProjectID *string `json:"project_id"`
	ModuleID  *string `json:"module_id"`
}
type CockpitActionView struct {
	ID                string               `json:"id"`
	MeetingID         string               `json:"meeting_id"`
	VersionID         string               `json:"version_id"`
	VersionNumber     int32                `json:"version_number"`
	SourceContentHash string               `json:"source_content_hash"`
	SourceQuote       string               `json:"source_quote"`
	Title             string               `json:"title"`
	Description       string               `json:"description"`
	Status            string               `json:"status"`
	Resolution        *string              `json:"resolution"`
	Revision          int64                `json:"revision"`
	ProposalKey       string               `json:"proposal_key"`
	DecisionKey       *string              `json:"decision_key"`
	NodeID            *string              `json:"node_id"`
	NodeCode          string               `json:"node_code"`
	NodeName          string               `json:"node_name"`
	Issue             *CockpitIssueSummary `json:"issue"`
	Reason            string               `json:"reason"`
	CreatedBy         string               `json:"created_by"`
	CreatedAt         string               `json:"created_at"`
	UpdatedAt         string               `json:"updated_at"`
	ResolvedBy        *string              `json:"resolved_by"`
	ResolvedAt        *string              `json:"resolved_at"`
	CanEdit           bool                 `json:"can_edit"`
	CanResolve        bool                 `json:"can_resolve"`
	SourceSuperseded  bool                 `json:"source_superseded"`
}
type CockpitActionPage struct {
	MeetingID     string              `json:"meeting_id"`
	Items         []CockpitActionView `json:"items"`
	Total         int64               `json:"total"`
	FilteredTotal int64               `json:"filtered_total"`
	NextCursor    *string             `json:"next_cursor"`
	CanAdd        bool                `json:"can_add"`
}
type CockpitExecutionEligibility struct {
	Eligible  bool    `json:"eligible"`
	Reason    string  `json:"reason"`
	ProjectID *string `json:"project_id"`
	ModuleID  *string `json:"module_id"`
}
type CockpitStatusCount struct {
	Status   string `json:"status"`
	Category string `json:"category"`
	Count    int64  `json:"count"`
}
type CockpitNodeTaskSummary struct {
	Total      int64                `json:"total"`
	ByStatus   []CockpitStatusCount `json:"by_status"`
	ByCategory map[string]int64     `json:"by_category"`
	Done       int64                `json:"done"`
	Closed     int64                `json:"closed"`
	Unknown    int64                `json:"unknown"`
}
type CockpitNodeTaskPage struct {
	NodeID        string                      `json:"node_id"`
	Items         []CockpitIssueSummary       `json:"items"`
	Total         int64                       `json:"total"`
	FilteredTotal int64                       `json:"filtered_total"`
	NextCursor    *string                     `json:"next_cursor"`
	Summary       CockpitNodeTaskSummary      `json:"summary"`
	Eligibility   CockpitExecutionEligibility `json:"eligibility"`
}
