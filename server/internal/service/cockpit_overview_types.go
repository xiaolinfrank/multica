package service

import "github.com/jackc/pgx/v5/pgtype"

// AsOf is a caller-local calendar date, not a historical snapshot timestamp.
type CockpitOverviewQuery struct {
	WorkspaceID, ProjectID, ModuleID, ActorID pgtype.UUID
	Human                                     bool
	AsOf, View, Kind, Cursor                  string
	Days, PageSize                            int32
}

type CockpitOverviewScope struct {
	WorkspaceID  string  `json:"workspace_id"`
	ProjectID    *string `json:"project_id"`
	ProjectTitle string  `json:"project_title"`
	ModuleID     *string `json:"module_id"`
	ModuleTitle  string  `json:"module_title"`
	AsOf         string  `json:"as_of"`
	GeneratedAt  string  `json:"generated_at"`
}
type CockpitOverviewBoard struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	GoalTitle string  `json:"goal_title"`
	GoalDate  *string `json:"goal_date"`
}
type CockpitOverviewActor struct {
	UserID  string `json:"user_id"`
	Role    string `json:"role"`
	IsHuman bool   `json:"is_human"`
}
type CockpitOverviewIssueCounts struct {
	Total      int64 `json:"total"`
	Active     int64 `json:"active"`
	Unstarted  int64 `json:"unstarted"`
	Started    int64 `json:"started"`
	Done       int64 `json:"done"`
	Closed     int64 `json:"closed"`
	Unknown    int64 `json:"unknown"`
	Overdue    int64 `json:"overdue"`
	Blocked    int64 `json:"blocked"`
	Unassigned int64 `json:"unassigned"`
}
type CockpitOverviewSummary struct {
	PrimaryIssues   CockpitOverviewIssueCounts `json:"primary_issues"`
	MyPrimaryIssues CockpitOverviewIssueCounts `json:"my_primary_issues"`
	ExecutionNodes  struct {
		Total            int64 `json:"total"`
		WithActiveIssues int64 `json:"with_active_issues"`
	} `json:"execution_nodes"`
	Attention struct {
		TeamTotal  int64            `json:"team_total"`
		MineTotal  int64            `json:"mine_total"`
		TeamByKind map[string]int64 `json:"team_by_kind"`
		MineByKind map[string]int64 `json:"mine_by_kind"`
	} `json:"attention"`
}

// IDs identify existing product destinations; clients construct their own routes.
type CockpitAttentionTarget struct {
	Kind      string  `json:"kind"`
	ID        string  `json:"id"`
	MeetingID *string `json:"meeting_id"`
	VersionID *string `json:"version_id"`
	NodeID    *string `json:"node_id"`
	IssueID   *string `json:"issue_id"`
	ActionID  *string `json:"action_id"`
	ExportID  *string `json:"export_id"`
}
type CockpitAttentionItem struct {
	ID                  string                 `json:"id"`
	Kind                string                 `json:"kind"`
	Reason              string                 `json:"reason"`
	Title               string                 `json:"title"`
	Flags               []string               `json:"flags"`
	CreatedAt           string                 `json:"created_at"`
	DueDate             *string                `json:"due_date"`
	Responsibility      string                 `json:"responsibility"`
	AssigneeType        *string                `json:"assignee_type"`
	AssigneeID          *string                `json:"assignee_id"`
	AssigneeName        string                 `json:"assignee_name"`
	CanAct              bool                   `json:"can_act"`
	NextAction          string                 `json:"next_action"`
	Target              CockpitAttentionTarget `json:"target"`
	MeetingCode         string                 `json:"meeting_code"`
	MeetingTitle        string                 `json:"meeting_title"`
	VersionNumber       *int32                 `json:"version_number"`
	NodeCode            string                 `json:"node_code"`
	NodeName            string                 `json:"node_name"`
	IssueIdentifier     string                 `json:"issue_identifier"`
	IssueStatus         string                 `json:"issue_status"`
	IssueStatusCategory string                 `json:"issue_status_category"`
}
type CockpitAttentionPage struct {
	CockpitOverviewScope
	View       string                 `json:"view"`
	Kind       string                 `json:"kind"`
	Items      []CockpitAttentionItem `json:"items"`
	Total      int64                  `json:"total"`
	NextCursor *string                `json:"next_cursor"`
}
type CockpitExecutionOverviewItem struct {
	ID            string                     `json:"id"`
	Code          string                     `json:"code"`
	Name          string                     `json:"name"`
	ProjectID     string                     `json:"project_id"`
	ProjectTitle  string                     `json:"project_title"`
	ModuleID      string                     `json:"module_id"`
	ModuleTitle   string                     `json:"module_title"`
	PlanOwner     string                     `json:"plan_owner"`
	PlanStatus    string                     `json:"plan_status"`
	PlanStartDate *string                    `json:"plan_start_date"`
	PlanEndDate   *string                    `json:"plan_end_date"`
	IssueCounts   CockpitOverviewIssueCounts `json:"issue_counts"`
}
type CockpitExecutionOverviewPage struct {
	CockpitOverviewScope
	Items      []CockpitExecutionOverviewItem `json:"items"`
	Total      int64                          `json:"total"`
	NextCursor *string                        `json:"next_cursor"`
}
type CockpitRecentMeeting struct {
	ID                   string  `json:"id"`
	Code                 string  `json:"code"`
	Title                string  `json:"title"`
	MeetDate             string  `json:"meet_date"`
	TimeRange            string  `json:"time_range"`
	MeetingStatus        string  `json:"meeting_status"`
	EndedAt              *string `json:"ended_at"`
	WorkflowEnabled      bool    `json:"workflow_enabled"`
	WorkflowStage        string  `json:"workflow_stage"`
	MinutesIssueID       *string `json:"minutes_issue_id"`
	CurrentVersionID     *string `json:"current_version_id"`
	CurrentVersionNumber *int32  `json:"current_version_number"`
	PublishedVersionID   *string `json:"published_version_id"`
}
type CockpitRecentMeetingPage struct {
	CockpitOverviewScope
	RangeStart string                 `json:"range_start"`
	RangeEnd   string                 `json:"range_end"`
	Items      []CockpitRecentMeeting `json:"items"`
	Total      int64                  `json:"total"`
	NextCursor *string                `json:"next_cursor"`
}
type CockpitOverview struct {
	CockpitOverviewScope
	Board          *CockpitOverviewBoard        `json:"board"`
	Actor          CockpitOverviewActor         `json:"actor"`
	Summary        CockpitOverviewSummary       `json:"summary"`
	Attention      CockpitAttentionPage         `json:"attention"`
	ExecutionNodes CockpitExecutionOverviewPage `json:"execution_nodes"`
	RecentMeetings CockpitRecentMeetingPage     `json:"recent_meetings"`
}
