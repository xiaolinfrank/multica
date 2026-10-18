package service

// Context rows are fixed domain objects, not editable Issue relation tags.
// A production Issue with many versions is paged by version, never one huge row.
type CockpitIssueArtifactContext struct {
	Kind            string   `json:"kind"`
	ID              string   `json:"id"`
	Roles           []string `json:"roles"`
	ArtifactID      *string  `json:"artifact_id"`
	ArtifactTitle   string   `json:"artifact_title"`
	VersionID       *string  `json:"version_id"`
	VersionNumber   *int32   `json:"version_number"`
	NodeID          string   `json:"node_id"`
	NodeLabel       string   `json:"node_label"`
	RequestID       *string  `json:"request_id"`
	Decision        string   `json:"decision"`
	ReviewerID      *string  `json:"reviewer_id"`
	IsCurrentReview bool     `json:"is_current_review"`
}
type CockpitIssueFormalReview struct {
	Kind       string  `json:"kind"`
	Stage      string  `json:"stage"`
	NodeID     string  `json:"node_id"`
	ArtifactID *string `json:"artifact_id"`
	VersionID  *string `json:"version_id"`
	RequestID  *string `json:"request_id"`
}
type CockpitIssueArtifactContextPage struct {
	FormalReview *CockpitIssueFormalReview     `json:"formal_review"`
	WorkspaceID  string                        `json:"workspace_id"`
	IssueID      string                        `json:"issue_id"`
	Items        []CockpitIssueArtifactContext `json:"items"`
	Total        int64                         `json:"total"`
	NextCursor   *string                       `json:"next_cursor"`
}
