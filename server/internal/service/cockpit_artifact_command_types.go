package service

import "github.com/jackc/pgx/v5/pgtype"

type CockpitArtifactProducerCommand struct {
	CockpitArtifactCommand
	CommandKey, IssueID pgtype.UUID
	NewIssue            *IssueCreateParams
	Reason              string
}
type CockpitArtifactReviewerCommand struct {
	CockpitArtifactCommand
	HandoffKey, ReviewerID pgtype.UUID
	Reason                 string
}
type CockpitArtifactReferenceCommand struct {
	CockpitArtifactCommand
	ReferenceKey, ReferenceID, VersionID, NodeID, MeetingID pgtype.UUID
	Purpose                                                 string
}
type CockpitArtifactCaptureRetry struct {
	CockpitArtifactCommand
	VersionID pgtype.UUID
}
type CockpitAcceptanceRead struct {
	WorkspaceID, ActorID, NodeID, RequestID pgtype.UUID
	Human                                   bool
	Cursor                                  string
	PageSize                                int32
}
type CockpitAcceptanceCriteriaCommand struct {
	WorkspaceID, ActorID, NodeID pgtype.UUID
	Human                        bool
	ExpectedRevision             int64
	Criteria                     []CockpitAcceptanceCriterionInput
}
type CockpitAcceptanceRequestCommand struct {
	WorkspaceID, ActorID, NodeID, RequestKey, ReviewerID, SupersedesRequestID pgtype.UUID
	Human                                                                     bool
	ExpectedCriteriaRevision                                                  int64
	Evidence                                                                  []CockpitAcceptanceEvidenceInput
	Note                                                                      string
}
type CockpitAcceptanceReview struct {
	WorkspaceID, ActorID, NodeID, RequestID pgtype.UUID
	Human                                   bool
	ExpectedRevision                        int64
	Decision, Feedback                      string
}
type CockpitAcceptanceReviewerCommand struct {
	WorkspaceID, ActorID, NodeID, RequestID, HandoffKey, ReviewerID pgtype.UUID
	Human                                                           bool
	ExpectedRevision                                                int64
	Reason                                                          string
}
type CockpitMeetingArtifactReferencesRead struct {
	WorkspaceID, ActorID, MeetingID pgtype.UUID
	Human, IncludeRemoved           bool
	Cursor                          string
	PageSize                        int32
}
type CockpitMeetingArtifactReference struct {
	VersionDecision *string `json:"version_decision"`
	CockpitArtifactReference
	ArtifactTitle string `json:"artifact_title"`
}
type CockpitMeetingArtifactReferencesPage struct {
	WorkspaceID    string                            `json:"workspace_id"`
	MeetingID      string                            `json:"meeting_id"`
	IncludeRemoved bool                              `json:"include_removed"`
	Items          []CockpitMeetingArtifactReference `json:"items"`
	Total          int64                             `json:"total"`
	NextCursor     *string                           `json:"next_cursor"`
}
