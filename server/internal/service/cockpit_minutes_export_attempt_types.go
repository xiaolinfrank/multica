package service

import "github.com/jackc/pgx/v5/pgtype"

type CockpitMinutesExportAttemptList struct {
	WorkspaceID, MeetingID, ExportID pgtype.UUID
	Cursor                           string
	PageSize                         int32
}

type CockpitMinutesExportAttemptView struct {
	ID                  string  `json:"id"`
	AttemptNumber       int32   `json:"attempt_number"`
	Status              string  `json:"status"`
	TargetPath          string  `json:"target_path"`
	ReceiptPath         string  `json:"receipt_path"`
	ContentHash         string  `json:"content_hash"`
	VerifiedPath        *string `json:"verified_path"`
	VerifiedReceiptPath *string `json:"verified_receipt_path"`
	VerifiedAttemptID   *string `json:"verified_attempt_id"`
	ReceiptHash         *string `json:"receipt_hash"`
	SizeBytes           *int64  `json:"size_bytes"`
	LastErrorCode       string  `json:"last_error_code"`
	LastError           string  `json:"last_error"`
	CreatedAt           string  `json:"created_at"`
	UpdatedAt           string  `json:"updated_at"`
	VerifiedAt          *string `json:"verified_at"`
}

type CockpitMinutesExportAttemptPage struct {
	WorkspaceID string                            `json:"workspace_id"`
	MeetingID   string                            `json:"meeting_id"`
	ExportID    string                            `json:"export_id"`
	Items       []CockpitMinutesExportAttemptView `json:"items"`
	Total       int64                             `json:"total"`
	NextCursor  *string                           `json:"next_cursor"`
}
