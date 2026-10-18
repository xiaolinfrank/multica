package service

// Existing Issue attachments are selected by a bounded metadata page. Listing
// never creates an artifact, uploads bytes, or grants a new filesystem source.
type CockpitInputAttachment struct {
	ID          string `json:"id"`
	IssueID     string `json:"issue_id"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	SizeBytes   int64  `json:"size_bytes"`
	CreatedAt   string `json:"created_at"`
}

type CockpitInputAttachmentPage struct {
	WorkspaceID    string                   `json:"workspace_id"`
	IssueID        string                   `json:"issue_id"`
	Query          string                   `json:"q"`
	PageSize       int32                    `json:"page_size"`
	Items          []CockpitInputAttachment `json:"items"`
	Total          int64                    `json:"total"`
	NextCursor     *string                  `json:"next_cursor"`
	CanCapture     bool                     `json:"can_capture"`
	BlockedReasons []string                 `json:"blocked_reasons"`
}
