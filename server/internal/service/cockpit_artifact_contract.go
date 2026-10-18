package service

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
)

const (
	CockpitArtifactMaxTextBytes              = 128 << 10
	CockpitAcceptanceMaxCriteria             = 50
	CockpitAcceptanceMaxVersionsPerCriterion = 20
	CockpitAcceptanceMaxEvidenceVersions     = 200
)

// Payload fields deliberately distinguish absent values from an explicitly empty text.
type CockpitArtifactPayload struct {
	Kind         string  `json:"kind"`
	Content      *string `json:"content,omitempty"`
	AttachmentID *string `json:"attachment_id,omitempty"`
}

type CockpitArtifactPayloadIdentity struct {
	Kind         string `json:"kind"`
	Content      string `json:"content,omitempty"`
	AttachmentID string `json:"attachment_id,omitempty"`
	ContentHash  string `json:"content_hash,omitempty"`
}

func NormalizeCockpitArtifactPayload(payload CockpitArtifactPayload) (CockpitArtifactPayloadIdentity, error) {
	switch payload.Kind {
	case "text":
		if payload.Content == nil || payload.AttachmentID != nil || !utf8.ValidString(*payload.Content) ||
			strings.TrimSpace(*payload.Content) == "" || len(*payload.Content) > CockpitArtifactMaxTextBytes {
			return CockpitArtifactPayloadIdentity{}, fmt.Errorf("%w: text artifacts require nonempty UTF-8 content up to 128 KiB and no attachment_id", ErrCockpitWorkflowInput)
		}
		// Whitespace is part of the fixed version, including its trailing newline.
		return CockpitArtifactPayloadIdentity{Kind: "text", Content: *payload.Content, ContentHash: fmt.Sprintf("%x", sha256.Sum256([]byte(*payload.Content)))}, nil
	case "attachment":
		if payload.Content != nil || payload.AttachmentID == nil {
			return CockpitArtifactPayloadIdentity{}, fmt.Errorf("%w: file artifacts require attachment_id and no content field", ErrCockpitWorkflowInput)
		}
		id, err := uuid.Parse(*payload.AttachmentID)
		if err != nil || id == uuid.Nil {
			return CockpitArtifactPayloadIdentity{}, fmt.Errorf("%w: attachment_id must be a nonzero UUID", ErrCockpitWorkflowInput)
		}
		return CockpitArtifactPayloadIdentity{Kind: "attachment", AttachmentID: id.String()}, nil
	default:
		return CockpitArtifactPayloadIdentity{}, fmt.Errorf("%w: artifact payload kind must be text or attachment", ErrCockpitWorkflowInput)
	}
}

func NormalizeCockpitArtifactText(title, description string) (string, string, error) {
	title, description = strings.TrimSpace(title), strings.TrimSpace(description)
	if title == "" || !utf8.ValidString(title) || !utf8.ValidString(description) || utf8.RuneCountInString(title) > 500 || len(description) > 16000 {
		return "", "", fmt.Errorf("%w: artifact title is required and limited to 500 characters; description is limited to 16000 UTF-8 bytes", ErrCockpitWorkflowInput)
	}
	return title, description, nil
}

type CockpitAcceptanceCriterionInput struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

func NormalizeCockpitAcceptanceCriteria(input []CockpitAcceptanceCriterionInput) ([]CockpitAcceptanceCriterionInput, error) {
	if len(input) > CockpitAcceptanceMaxCriteria {
		return nil, fmt.Errorf("%w: an L3 acceptance definition is limited to 50 criteria", ErrCockpitWorkflowInput)
	}
	out := make([]CockpitAcceptanceCriterionInput, 0, len(input))
	seen := make(map[uuid.UUID]bool, len(input))
	for _, criterion := range input {
		id, err := uuid.Parse(criterion.ID)
		if err != nil || id == uuid.Nil || seen[id] {
			return nil, fmt.Errorf("%w: acceptance criteria require distinct nonzero UUIDs", ErrCockpitWorkflowInput)
		}
		seen[id] = true
		criterion.ID = id.String()
		criterion.Title, criterion.Description, err = NormalizeCockpitArtifactText(criterion.Title, criterion.Description)
		if err != nil {
			return nil, err
		}
		out = append(out, criterion)
	}
	return out, nil
}

type CockpitAcceptanceEvidenceInput struct {
	CriterionID string   `json:"criterion_id"`
	VersionIDs  []string `json:"version_ids"`
}

func NormalizeCockpitAcceptanceEvidence(input []CockpitAcceptanceEvidenceInput) ([]CockpitAcceptanceEvidenceInput, error) {
	if len(input) == 0 || len(input) > CockpitAcceptanceMaxCriteria {
		return nil, fmt.Errorf("%w: acceptance requires evidence for 1 to 50 criteria", ErrCockpitWorkflowInput)
	}
	out := make([]CockpitAcceptanceEvidenceInput, 0, len(input))
	criteria := make(map[uuid.UUID]bool, len(input))
	versions := make(map[string]bool)
	for _, evidence := range input {
		criterion, err := uuid.Parse(evidence.CriterionID)
		if err != nil || criterion == uuid.Nil || criteria[criterion] {
			return nil, fmt.Errorf("%w: each acceptance criterion must occur once", ErrCockpitWorkflowInput)
		}
		criteria[criterion] = true
		if len(evidence.VersionIDs) == 0 || len(evidence.VersionIDs) > CockpitAcceptanceMaxVersionsPerCriterion {
			return nil, fmt.Errorf("%w: each criterion requires 1 to 20 fixed artifact versions", ErrCockpitWorkflowInput)
		}
		normalized := CockpitAcceptanceEvidenceInput{CriterionID: criterion.String(), VersionIDs: make([]string, 0, len(evidence.VersionIDs))}
		seen := make(map[string]bool, len(evidence.VersionIDs))
		for _, raw := range evidence.VersionIDs {
			version, err := uuid.Parse(raw)
			if err != nil || version == uuid.Nil || seen[version.String()] {
				return nil, fmt.Errorf("%w: evidence must reference distinct nonzero version UUIDs", ErrCockpitWorkflowInput)
			}
			seen[version.String()] = true
			versions[version.String()] = true
			normalized.VersionIDs = append(normalized.VersionIDs, version.String())
		}
		sort.Strings(normalized.VersionIDs)
		out = append(out, normalized)
	}
	if len(versions) > CockpitAcceptanceMaxEvidenceVersions {
		return nil, fmt.Errorf("%w: one acceptance request is limited to 200 distinct evidence versions", ErrCockpitWorkflowInput)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CriterionID < out[j].CriterionID })
	return out, nil
}

type CockpitArtifactScope struct {
	IDs           []string `json:"ids"`
	ProjectID     *string  `json:"project_id"`
	ModuleID      *string  `json:"module_id"`
	NodeID        *string  `json:"node_id"`
	SourceIssueID *string  `json:"source_issue_id"`
	Query         string   `json:"q"`
	Status        string   `json:"status"`
	Relation      string   `json:"relation"`
}

type CockpitArtifactVersionMetadata struct {
	InputManifestVersionID     *string              `json:"input_manifest_version_id"`
	InputManifestIssueID       *string              `json:"input_manifest_issue_id"`
	InputManifestVersionNumber *int32               `json:"input_manifest_version_number"`
	InputManifestHash          *string              `json:"input_manifest_hash"`
	ID                         string               `json:"id"`
	ArtifactID                 string               `json:"artifact_id"`
	VersionNumber              int32                `json:"version_number"`
	SubmissionKey              string               `json:"submission_key"`
	ProducerIssueID            string               `json:"producer_issue_id"`
	ProducerIssueIdentifier    string               `json:"producer_issue_identifier"`
	ProducerIssueTitle         string               `json:"producer_issue_title"`
	ProducerRunID              *string              `json:"producer_run_id"`
	SourceMeetingID            *string              `json:"source_meeting_id"`
	SourceMeetingTitle         string               `json:"source_meeting_title"`
	SourceMinutesVersionID     *string              `json:"source_minutes_version_id"`
	SourceMinutesVersionNumber *int32               `json:"source_minutes_version_number"`
	Revision                   int64                `json:"revision"`
	PayloadKind                string               `json:"payload_kind"`
	SourceAttachmentID         *string              `json:"source_attachment_id"`
	Filename                   string               `json:"filename"`
	ContentType                string               `json:"content_type"`
	SizeBytes                  *int64               `json:"size_bytes"`
	ContentHash                *string              `json:"content_hash"`
	CaptureStatus              string               `json:"capture_status"`
	CaptureErrorCode           string               `json:"capture_error_code"`
	CaptureError               string               `json:"capture_error"`
	Decision                   string               `json:"decision"`
	ReviewerID                 string               `json:"reviewer_id"`
	ReviewIssue                *CockpitIssueSummary `json:"review_issue"`
	SubmittedByType            string               `json:"submitted_by_type"`
	SubmittedByID              string               `json:"submitted_by_id"`
	CreatedAt                  string               `json:"created_at"`
	ReviewedAt                 *string              `json:"reviewed_at"`
	HasFeedback                bool                 `json:"has_feedback"`
	CanReview                  bool                 `json:"can_review"`
	CanRetryCapture            bool                 `json:"can_retry_capture"`
}

type CockpitArtifactHeader struct {
	FileCaptureAvailable         bool                            `json:"file_capture_available"`
	FileCaptureUnavailableReason string                          `json:"file_capture_unavailable_reason"`
	ID                           string                          `json:"id"`
	WorkspaceID                  string                          `json:"workspace_id"`
	CreationKey                  string                          `json:"creation_key"`
	NodeID                       string                          `json:"node_id"`
	NodeLabel                    string                          `json:"node_label"`
	ProjectID                    string                          `json:"project_id"`
	ModuleID                     string                          `json:"module_id"`
	SourceIssue                  CockpitIssueSummary             `json:"source_issue"`
	ProducerIssue                CockpitIssueSummary             `json:"producer_issue"`
	CreatedBy                    string                          `json:"created_by"`
	Title                        string                          `json:"title"`
	Description                  string                          `json:"description"`
	Status                       string                          `json:"status"`
	Revision                     int64                           `json:"revision"`
	ReviewerID                   string                          `json:"reviewer_id"`
	ArchivedAt                   *string                         `json:"archived_at"`
	CurrentVersion               *CockpitArtifactVersionMetadata `json:"current_version"`
	ApprovedVersion              *CockpitArtifactVersionMetadata `json:"approved_version"`
	EvidenceVersion              *CockpitArtifactVersionMetadata `json:"evidence_version"`
	VersionCount                 int64                           `json:"version_count"`
	CanEdit                      bool                            `json:"can_edit"`
	CanSubmit                    bool                            `json:"can_submit"`
	CanArchive                   bool                            `json:"can_archive"`
	CanRestore                   bool                            `json:"can_restore"`
	CanAssignProducer            bool                            `json:"can_assign_producer"`
	CanReassignReviewer          bool                            `json:"can_reassign_reviewer"`
	CanReference                 bool                            `json:"can_reference"`
}

type CockpitArtifactPage struct {
	WorkspaceID   string                  `json:"workspace_id"`
	Scope         CockpitArtifactScope    `json:"scope"`
	Items         []CockpitArtifactHeader `json:"items"`
	Total         int64                   `json:"total"`
	FilteredTotal int64                   `json:"filtered_total"`
	NextCursor    *string                 `json:"next_cursor"`
	CanCreate     bool                    `json:"can_create"`
}

type CockpitArtifactVersionPage struct {
	WorkspaceID      string                           `json:"workspace_id"`
	ArtifactID       string                           `json:"artifact_id"`
	ArtifactRevision int64                            `json:"artifact_revision"`
	Items            []CockpitArtifactVersionMetadata `json:"items"`
	Total            int64                            `json:"total"`
	NextCursor       *string                          `json:"next_cursor"`
}

type CockpitArtifactVersionDetail struct {
	WorkspaceID              string                         `json:"workspace_id"`
	ArtifactID               string                         `json:"artifact_id"`
	Version                  CockpitArtifactVersionMetadata `json:"version"`
	Content                  *string                        `json:"content"`
	Feedback                 string                         `json:"feedback"`
	ContentAvailable         bool                           `json:"content_available"`
	ContentUnavailableReason string                         `json:"content_unavailable_reason"`
	DownloadURL              *string                        `json:"download_url"`
}

type CockpitArtifactVersionCommandResponse struct {
	WorkspaceID string                       `json:"workspace_id"`
	Artifact    CockpitArtifactHeader        `json:"artifact"`
	Version     CockpitArtifactVersionDetail `json:"version"`
}

type CockpitArtifactSourceAttachment struct {
	ID            string `json:"id"`
	SourceIssueID string `json:"source_issue_id"`
	Filename      string `json:"filename"`
	ContentType   string `json:"content_type"`
	SizeBytes     int64  `json:"size_bytes"`
	CreatedAt     string `json:"created_at"`
}
type CockpitArtifactSourceAttachmentPage struct {
	WorkspaceID     string                            `json:"workspace_id"`
	ArtifactID      string                            `json:"artifact_id"`
	ProducerIssueID string                            `json:"producer_issue_id"`
	Query           string                            `json:"q"`
	Items           []CockpitArtifactSourceAttachment `json:"items"`
	Total           int64                             `json:"total"`
	FilteredTotal   int64                             `json:"filtered_total"`
	NextCursor      *string                           `json:"next_cursor"`
}
type CockpitArtifactDownloadLink struct {
	WorkspaceID string `json:"workspace_id"`
	ArtifactID  string `json:"artifact_id"`
	VersionID   string `json:"version_id"`
	URL         string `json:"url"`
	ExpiresAt   string `json:"expires_at"`
}

type CockpitAcceptanceCriterionView struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Revision    int64  `json:"revision"`
	Position    int32  `json:"position"`
}

type CockpitAcceptanceCriteriaView struct {
	WorkspaceID string                           `json:"workspace_id"`
	NodeID      string                           `json:"node_id"`
	Revision    int64                            `json:"revision"`
	Items       []CockpitAcceptanceCriterionView `json:"items"`
	MaxItems    int32                            `json:"max_items"`
	CanEdit     bool                             `json:"can_edit"`
}

type CockpitAcceptanceRequestMetadata struct {
	ID                  string              `json:"id"`
	NodeID              string              `json:"node_id"`
	RequestKey          string              `json:"request_key"`
	Revision            int64               `json:"revision"`
	CriteriaRevision    int64               `json:"criteria_revision"`
	EvidenceHash        string              `json:"evidence_hash"`
	ReviewerID          string              `json:"reviewer_id"`
	ReviewIssue         CockpitIssueSummary `json:"review_issue"`
	Decision            string              `json:"decision"`
	HasFeedback         bool                `json:"has_feedback"`
	CreatedBy           string              `json:"created_by"`
	CreatedAt           string              `json:"created_at"`
	ReviewedAt          *string             `json:"reviewed_at"`
	CanReview           bool                `json:"can_review"`
	SupersedesRequestID *string             `json:"supersedes_request_id"`
	SupersededAt        *string             `json:"superseded_at"`
}

type CockpitAcceptanceHeader struct {
	WorkspaceID         string                            `json:"workspace_id"`
	NodeID              string                            `json:"node_id"`
	CriteriaRevision    int64                             `json:"criteria_revision"`
	CurrentRequest      *CockpitAcceptanceRequestMetadata `json:"current_request"`
	LastApprovedRequest *CockpitAcceptanceRequestMetadata `json:"last_approved_request"`
	RequestCount        int64                             `json:"request_count"`
	CanEditCriteria     bool                              `json:"can_edit_criteria"`
	CanRequest          bool                              `json:"can_request"`
	NeedsReacceptance   bool                              `json:"needs_reacceptance"`
	CanReassignReviewer bool                              `json:"can_reassign_reviewer"`
}

type CockpitAcceptanceRequestPage struct {
	WorkspaceID string                             `json:"workspace_id"`
	NodeID      string                             `json:"node_id"`
	Items       []CockpitAcceptanceRequestMetadata `json:"items"`
	Total       int64                              `json:"total"`
	NextCursor  *string                            `json:"next_cursor"`
}

type CockpitAcceptanceEvidenceView struct {
	Criterion CockpitAcceptanceCriterionView   `json:"criterion"`
	Versions  []CockpitArtifactVersionMetadata `json:"versions"`
}

type CockpitAcceptanceRequestDetail struct {
	WorkspaceID               string                           `json:"workspace_id"`
	NodeID                    string                           `json:"node_id"`
	Request                   CockpitAcceptanceRequestMetadata `json:"request"`
	Evidence                  []CockpitAcceptanceEvidenceView  `json:"evidence"`
	Note                      string                           `json:"note"`
	Feedback                  string                           `json:"feedback"`
	DefinitionChanged         bool                             `json:"definition_changed"`
	EvidenceOutdated          bool                             `json:"evidence_outdated"`
	EvidenceAvailable         bool                             `json:"evidence_available"`
	EvidenceUnavailableReason string                           `json:"evidence_unavailable_reason"`
}

// Fingerprints operate on normalized, fixed projections, never mutable Issue status.
func cockpitArtifactFingerprint(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", sha256.Sum256(encoded)), nil
}
