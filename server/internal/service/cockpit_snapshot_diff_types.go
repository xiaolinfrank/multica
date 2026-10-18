package service

import "encoding/json"

// Plan identity is additive snapshot metadata, never an import instruction.
type CockpitPlanSnapshotEntity struct {
	ID     string                     `json:"id"`
	Code   string                     `json:"code"`
	Name   string                     `json:"name"`
	Fields map[string]json.RawMessage `json:"fields"`
}
type CockpitPlanSnapshotCounts struct {
	Nodes      int `json:"nodes"`
	Payments   int `json:"payments"`
	Milestones int `json:"milestones"`
}
type CockpitPlanSnapshotIdentity struct {
	SchemaVersion int                         `json:"schema_version"`
	WorkspaceID   string                      `json:"workspace_id"`
	CockpitID     string                      `json:"cockpit_id"`
	Complete      bool                        `json:"complete"`
	Counts        CockpitPlanSnapshotCounts   `json:"counts"`
	Board         CockpitPlanSnapshotEntity   `json:"board"`
	Nodes         []CockpitPlanSnapshotEntity `json:"nodes"`
	Payments      []CockpitPlanSnapshotEntity `json:"payments"`
	Milestones    []CockpitPlanSnapshotEntity `json:"milestones"`
}
type CockpitSnapshotDiffValue struct {
	Value     json.RawMessage `json:"value"`
	Truncated bool            `json:"truncated"`
	SHA256    string          `json:"sha256"`
}
type CockpitSnapshotFieldChange struct {
	Field  string                   `json:"field"`
	Before CockpitSnapshotDiffValue `json:"before"`
	After  CockpitSnapshotDiffValue `json:"after"`
}
type CockpitSnapshotDiffItem struct {
	EntityKind   string                       `json:"entity_kind"`
	ID           string                       `json:"id"`
	Change       string                       `json:"change"`
	Code         string                       `json:"code"`
	Name         string                       `json:"name"`
	FieldChanges []CockpitSnapshotFieldChange `json:"field_changes"`
}
type CockpitSnapshotDiffCounts struct {
	Added     int `json:"added"`
	Removed   int `json:"removed"`
	Modified  int `json:"modified"`
	Unchanged int `json:"unchanged"`
}
type CockpitSnapshotDiff struct {
	WorkspaceID       string                    `json:"workspace_id"`
	SnapshotID        string                    `json:"snapshot_id"`
	SnapshotCreatedAt string                    `json:"snapshot_created_at"`
	SnapshotCockpitID string                    `json:"snapshot_cockpit_id"`
	CurrentCockpitID  *string                   `json:"current_cockpit_id"`
	Scope             string                    `json:"scope"`
	GeneratedAt       string                    `json:"generated_at"`
	Comparable        bool                      `json:"comparable"`
	Reason            string                    `json:"reason"`
	SnapshotComplete  bool                      `json:"snapshot_complete"`
	CurrentComplete   bool                      `json:"current_complete"`
	SnapshotCounts    CockpitPlanSnapshotCounts `json:"snapshot_counts"`
	CurrentCounts     CockpitPlanSnapshotCounts `json:"current_counts"`
	Counts            CockpitSnapshotDiffCounts `json:"counts"`
	Items             []CockpitSnapshotDiffItem `json:"items"`
	Total             int                       `json:"total"`
	PageSize          int32                     `json:"page_size"`
	NextCursor        *string                   `json:"next_cursor"`
	ComparisonToken   string                    `json:"comparison_token"`
}
