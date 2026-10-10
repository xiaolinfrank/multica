package service

type CockpitArtifactProducerAssignment struct {
	FromIssueIdentifier string `json:"from_issue_identifier"`
	FromIssueTitle      string `json:"from_issue_title"`
	ToIssueIdentifier   string `json:"to_issue_identifier"`
	ToIssueTitle        string `json:"to_issue_title"`
	CreatedByName       string `json:"created_by_name"`
	ID                  string `json:"id"`
	ArtifactID          string `json:"artifact_id"`
	CommandKey          string `json:"command_key"`
	FromIssueID         string `json:"from_issue_id"`
	ToIssueID           string `json:"to_issue_id"`
	Reason              string `json:"reason"`
	CreatedBy           string `json:"created_by"`
	CreatedAt           string `json:"created_at"`
	Revision            int64  `json:"revision"`
}
type CockpitArtifactProducerPage struct {
	WorkspaceID string                              `json:"workspace_id"`
	ArtifactID  string                              `json:"artifact_id"`
	Items       []CockpitArtifactProducerAssignment `json:"items"`
	Total       int64                               `json:"total"`
	NextCursor  *string                             `json:"next_cursor"`
}
type CockpitArtifactProducerResponse struct {
	WorkspaceID string                            `json:"workspace_id"`
	Artifact    CockpitArtifactHeader             `json:"artifact"`
	Assignment  CockpitArtifactProducerAssignment `json:"assignment"`
	ToIssue     CockpitIssueSummary               `json:"to_issue"`
}
type CockpitArtifactReviewerHandoff struct {
	FromReviewerName  string  `json:"from_reviewer_name"`
	ToReviewerName    string  `json:"to_reviewer_name"`
	CreatedByName     string  `json:"created_by_name"`
	ID                string  `json:"id"`
	ArtifactID        string  `json:"artifact_id"`
	HandoffKey        string  `json:"handoff_key"`
	FromReviewerID    string  `json:"from_reviewer_id"`
	ToReviewerID      string  `json:"to_reviewer_id"`
	VersionID         *string `json:"version_id"`
	VersionNumber     *int32  `json:"version_number"`
	FromReviewIssueID *string `json:"from_review_issue_id"`
	ToReviewIssueID   *string `json:"to_review_issue_id"`
	Reason            string  `json:"reason"`
	CreatedBy         string  `json:"created_by"`
	CreatedAt         string  `json:"created_at"`
	Revision          int64   `json:"revision"`
}
type CockpitArtifactHandoffPage struct {
	WorkspaceID string                           `json:"workspace_id"`
	ArtifactID  string                           `json:"artifact_id"`
	Items       []CockpitArtifactReviewerHandoff `json:"items"`
	Total       int64                            `json:"total"`
	NextCursor  *string                          `json:"next_cursor"`
}
type CockpitArtifactHandoffResponse struct {
	WorkspaceID string                          `json:"workspace_id"`
	Artifact    CockpitArtifactHeader           `json:"artifact"`
	Version     *CockpitArtifactVersionMetadata `json:"version"`
	Handoff     CockpitArtifactReviewerHandoff  `json:"handoff"`
}
type CockpitArtifactReference struct {
	ID            string  `json:"id"`
	ArtifactID    string  `json:"artifact_id"`
	VersionID     string  `json:"version_id"`
	VersionNumber int32   `json:"version_number"`
	ContentHash   string  `json:"content_hash"`
	ReferenceKey  string  `json:"reference_key"`
	NodeID        *string `json:"node_id,omitempty"`
	MeetingID     *string `json:"meeting_id,omitempty"`
	TargetLabel   string  `json:"target_label"`
	Purpose       string  `json:"purpose"`
	CreatedBy     string  `json:"created_by"`
	CreatedAt     string  `json:"created_at"`
	RemovedBy     *string `json:"removed_by"`
	RemovedAt     *string `json:"removed_at"`
}
type CockpitArtifactReferencePage struct {
	WorkspaceID string                     `json:"workspace_id"`
	ArtifactID  string                     `json:"artifact_id"`
	Items       []CockpitArtifactReference `json:"items"`
	Total       int64                      `json:"total"`
	NextCursor  *string                    `json:"next_cursor"`
}
type CockpitArtifactReferenceResponse struct {
	WorkspaceID string                   `json:"workspace_id"`
	Reference   CockpitArtifactReference `json:"reference"`
}
type CockpitAcceptanceReviewerHandoff struct {
	FromReviewerName  string `json:"from_reviewer_name"`
	ToReviewerName    string `json:"to_reviewer_name"`
	CreatedByName     string `json:"created_by_name"`
	ID                string `json:"id"`
	NodeID            string `json:"node_id"`
	RequestID         string `json:"request_id"`
	HandoffKey        string `json:"handoff_key"`
	FromReviewerID    string `json:"from_reviewer_id"`
	ToReviewerID      string `json:"to_reviewer_id"`
	FromReviewIssueID string `json:"from_review_issue_id"`
	ToReviewIssueID   string `json:"to_review_issue_id"`
	Reason            string `json:"reason"`
	CreatedBy         string `json:"created_by"`
	CreatedAt         string `json:"created_at"`
	Revision          int64  `json:"revision"`
}
type CockpitAcceptanceHandoffPage struct {
	WorkspaceID string                             `json:"workspace_id"`
	NodeID      string                             `json:"node_id"`
	Items       []CockpitAcceptanceReviewerHandoff `json:"items"`
	Total       int64                              `json:"total"`
	NextCursor  *string                            `json:"next_cursor"`
}
type CockpitAcceptanceHandoffResponse struct {
	WorkspaceID string                           `json:"workspace_id"`
	Acceptance  CockpitAcceptanceHeader          `json:"acceptance"`
	Request     CockpitAcceptanceRequestDetail   `json:"request"`
	Handoff     CockpitAcceptanceReviewerHandoff `json:"handoff"`
}
