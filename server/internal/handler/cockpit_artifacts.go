package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
)

func writeCockpitArtifactError(w http.ResponseWriter, r *http.Request, err error) bool {
	if errors.Is(err, service.ErrCockpitArtifactPrivateStorageRequired) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error(), "code": "private_storage_required"})
		return true
	}
	var reference *service.CockpitArtifactReferenceExistsError
	if errors.As(err, &reference) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error(), "code": "reference_exists", "existing_reference_id": reference.ExistingReferenceID})
		return true
	}
	if errors.Is(err, service.ErrCockpitArtifactVerificationTimeout) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error(), "code": "verification_timeout"})
		return true
	}
	return writeCockpitActionError(w, r, err)
}

func decodeCockpitArtifactBody(w http.ResponseWriter, r *http.Request, target any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "invalid artifact command body")
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		writeError(w, http.StatusBadRequest, "expected one JSON command")
		return false
	}
	return true
}

func (h *Handler) cockpitArtifactRead(w http.ResponseWriter, r *http.Request, humanOnly bool) (service.CockpitArtifactRead, bool) {
	var out service.CockpitArtifactRead
	if h.IssueService == nil || !h.IssueService.CockpitArtifactBackendReady {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "artifacts_unavailable", "error": "artifact services are not available"})
		return out, false
	}
	if humanOnly && isMachineCredentialActor(r) {
		writeError(w, http.StatusForbidden, "this operation requires a human actor")
		return out, false
	}
	scope, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return out, false
	}
	out.WorkspaceID, out.ActorID, out.Human, out.ProjectID, out.ModuleID = scope.WorkspaceID, scope.ActorID, scope.Human, scope.ProjectID, scope.ModuleID
	if !out.Human && r.Header.Get("X-Actor-Source") == "task_token" {
		out.AuthorID, ok = parseUUIDOrBadRequest(w, r.Header.Get("X-Agent-ID"), "agent identity")
		if !ok {
			return out, false
		}
		out.ProducerRunID, ok = parseUUIDOrBadRequest(w, r.Header.Get("X-Task-ID"), "task identity")
		if !ok {
			return out, false
		}
	}
	for _, field := range []struct {
		name  string
		value string
		out   *pgtype.UUID
	}{
		{"artifact_id", chi.URLParam(r, "artifactId"), &out.ArtifactID}, {"version_id", chi.URLParam(r, "versionId"), &out.VersionID},
		{"node_id", r.URL.Query().Get("node_id"), &out.NodeID}, {"source_issue_id", r.URL.Query().Get("source_issue_id"), &out.SourceIssueID},
	} {
		if field.value != "" {
			*field.out, ok = parseUUIDOrBadRequest(w, field.value, field.name)
			if !ok {
				return out, false
			}
		}
	}
	out.PageSize, ok = cockpitActionPageSize(w, r)
	if !ok {
		return out, false
	}
	query := r.URL.Query()
	out.Query, out.Status, out.Relation, out.Cursor = query.Get("q"), query.Get("status"), query.Get("relation"), query.Get("cursor")
	if raw := query.Get("ids"); raw != "" {
		values := strings.Split(raw, ",")
		if len(values) > 100 {
			writeError(w, http.StatusBadRequest, "ids supports at most 100 artifact UUIDs")
			return out, false
		}
		sort.Strings(values)
		seen := map[pgtype.UUID]bool{}
		for _, value := range values {
			id, valid := parseUUIDOrBadRequest(w, value, "ids")
			if !valid {
				return out, false
			}
			if !seen[id] {
				out.IDs = append(out.IDs, id)
				seen[id] = true
			}
		}
	}
	return out, true
}

func cockpitArtifactCommand(w http.ResponseWriter, read service.CockpitArtifactRead, revision *int64) (service.CockpitArtifactCommand, bool) {
	if revision == nil || *revision < 1 {
		writeError(w, http.StatusBadRequest, "expected_revision must be a positive integer")
		return service.CockpitArtifactCommand{}, false
	}
	return service.CockpitArtifactCommand{WorkspaceID: read.WorkspaceID, ActorID: read.ActorID, ArtifactID: read.ArtifactID, Human: read.Human, ExpectedRevision: *revision}, true
}

func (h *Handler) ListCockpitArtifacts(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitArtifactRead(w, r, false)
	if !ok {
		return
	}
	out, err := h.IssueService.ListCockpitArtifacts(r.Context(), p)
	if !writeCockpitArtifactError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) GetCockpitArtifact(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitArtifactRead(w, r, false)
	if ok {
		h.writeCockpitArtifactHeader(w, r, p)
	}
}
func (h *Handler) writeCockpitArtifactHeader(w http.ResponseWriter, r *http.Request, p service.CockpitArtifactRead) {
	out, err := h.IssueService.GetCockpitArtifact(r.Context(), p)
	if !writeCockpitArtifactError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) ListCockpitArtifactVersions(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitArtifactRead(w, r, false)
	if !ok {
		return
	}
	out, err := h.IssueService.ListCockpitArtifactVersions(r.Context(), p)
	if !writeCockpitArtifactError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) GetCockpitArtifactVersion(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitArtifactRead(w, r, false)
	if !ok {
		return
	}
	out, err := h.IssueService.GetCockpitArtifactVersion(r.Context(), p)
	if !writeCockpitArtifactError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) CreateCockpitArtifact(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitArtifactRead(w, r, true)
	if !ok {
		return
	}
	var req struct {
		CreationKey   string `json:"creation_key"`
		NodeID        string `json:"node_id"`
		SourceIssueID string `json:"source_issue_id"`
		ReviewerID    string `json:"reviewer_id"`
		Title         string `json:"title"`
		Description   string `json:"description"`
	}
	if !decodeCockpitArtifactBody(w, r, &req) {
		return
	}
	input := service.CockpitArtifactCreate{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID, Human: p.Human, Title: req.Title, Description: req.Description}
	for _, field := range []struct {
		value, name string
		out         *pgtype.UUID
	}{
		{req.CreationKey, "creation_key", &input.CreationKey}, {req.NodeID, "node_id", &input.NodeID}, {req.SourceIssueID, "source_issue_id", &input.SourceIssueID}, {req.ReviewerID, "reviewer_id", &input.ReviewerID},
	} {
		*field.out, ok = parseUUIDOrBadRequest(w, field.value, field.name)
		if !ok {
			return
		}
	}
	id, err := h.IssueService.CreateCockpitArtifact(r.Context(), input)
	if writeCockpitArtifactError(w, r, err) {
		return
	}
	p.ArtifactID, p.NodeID = id, input.NodeID
	h.writeCockpitArtifactHeader(w, r, p)
}

func (h *Handler) EditCockpitArtifact(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitArtifactRead(w, r, true)
	if !ok {
		return
	}
	var req struct {
		cockpitWorkflowRevisionRequest
		Title       *string `json:"title"`
		Description *string `json:"description"`
	}
	if !decodeCockpitArtifactBody(w, r, &req) {
		return
	}
	command, ok := cockpitArtifactCommand(w, p, req.ExpectedRevision)
	if !ok {
		return
	}
	if req.Title == nil || req.Description == nil {
		writeError(w, http.StatusBadRequest, "title and description are required")
		return
	}
	err := h.IssueService.EditCockpitArtifact(r.Context(), service.CockpitArtifactEdit{CockpitArtifactCommand: command, Title: *req.Title, Description: *req.Description})
	if !writeCockpitArtifactError(w, r, err) {
		h.writeCockpitArtifactHeader(w, r, p)
	}
}

func (h *Handler) ArchiveCockpitArtifact(w http.ResponseWriter, r *http.Request) {
	h.archiveCockpitArtifact(w, r, true)
}
func (h *Handler) UnarchiveCockpitArtifact(w http.ResponseWriter, r *http.Request) {
	h.archiveCockpitArtifact(w, r, false)
}
func (h *Handler) archiveCockpitArtifact(w http.ResponseWriter, r *http.Request, archived bool) {
	p, ok := h.cockpitArtifactRead(w, r, true)
	if !ok {
		return
	}
	var req cockpitWorkflowRevisionRequest
	if !decodeCockpitArtifactBody(w, r, &req) {
		return
	}
	command, ok := cockpitArtifactCommand(w, p, req.ExpectedRevision)
	if !ok {
		return
	}
	if !writeCockpitArtifactError(w, r, h.IssueService.ArchiveCockpitArtifact(r.Context(), command, archived)) {
		h.writeCockpitArtifactHeader(w, r, p)
	}
}

func (h *Handler) SubmitCockpitArtifactVersion(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitArtifactRead(w, r, false)
	if !ok {
		return
	}
	var req struct {
		cockpitWorkflowRevisionRequest
		SubmissionKey          string                         `json:"submission_key"`
		ProducerIssueID        string                         `json:"producer_issue_id"`
		SourceMeetingID        *string                        `json:"source_meeting_id"`
		SourceMinutesVersionID *string                        `json:"source_minutes_version_id"`
		InputManifestVersionID *string                        `json:"input_manifest_version_id"`
		Payload                service.CockpitArtifactPayload `json:"payload"`
	}
	if !decodeCockpitArtifactBody(w, r, &req) {
		return
	}
	command, ok := cockpitArtifactCommand(w, p, req.ExpectedRevision)
	if !ok {
		return
	}
	input := service.CockpitArtifactSubmission{CockpitArtifactCommand: command, Payload: req.Payload, ActorType: "member", AuthorID: p.ActorID}
	for _, field := range []struct {
		value, name string
		out         *pgtype.UUID
	}{{req.SubmissionKey, "submission_key", &input.SubmissionKey}, {req.ProducerIssueID, "producer_issue_id", &input.ProducerIssueID}} {
		*field.out, ok = parseUUIDOrBadRequest(w, field.value, field.name)
		if !ok {
			return
		}
	}
	for _, field := range []struct {
		value *string
		name  string
		out   *pgtype.UUID
	}{{req.SourceMeetingID, "source_meeting_id", &input.SourceMeetingID}, {req.SourceMinutesVersionID, "source_minutes_version_id", &input.SourceMinutesVersionID}, {req.InputManifestVersionID, "input_manifest_version_id", &input.InputManifestVersionID}} {
		if field.value != nil {
			*field.out, ok = parseUUIDOrBadRequest(w, *field.value, field.name)
			if !ok {
				return
			}
		}
	}
	if !p.Human {
		if req.InputManifestVersionID != nil {
			writeError(w, http.StatusForbidden, "a producer task uses only its own fixed input manifest")
			return
		}
		if r.Header.Get("X-Actor-Source") != "task_token" {
			writeError(w, http.StatusForbidden, "submission requires a trusted producer task credential")
			return
		}
		input.ActorType = "agent"
		input.AuthorID, ok = parseUUIDOrBadRequest(w, r.Header.Get("X-Agent-ID"), "agent identity")
		if !ok {
			return
		}
		input.ProducerRunID, ok = parseUUIDOrBadRequest(w, r.Header.Get("X-Task-ID"), "task identity")
		if !ok {
			return
		}
	}
	version, err := h.IssueService.SubmitCockpitArtifactVersion(r.Context(), input, service.IssueCreateOpts{ActorID: uuidToString(input.AuthorID)})
	if writeCockpitArtifactError(w, r, err) {
		return
	}
	p.VersionID = version
	status := http.StatusOK
	if req.Payload.Kind == "attachment" {
		status = http.StatusAccepted
	}
	h.writeCockpitArtifactVersionCommand(w, r, p, status)
}

func (h *Handler) writeCockpitArtifactVersionCommand(w http.ResponseWriter, r *http.Request, p service.CockpitArtifactRead, status int) {
	version, err := h.IssueService.GetCockpitArtifactVersion(r.Context(), p)
	if writeCockpitArtifactError(w, r, err) {
		return
	}
	artifact, err := h.IssueService.GetCockpitArtifact(r.Context(), p)
	if writeCockpitArtifactError(w, r, err) {
		return
	}
	writeJSON(w, status, service.CockpitArtifactVersionCommandResponse{WorkspaceID: uuidToString(p.WorkspaceID), Artifact: artifact, Version: version})
}
func (h *Handler) ReviewCockpitArtifactVersion(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitArtifactRead(w, r, true)
	if !ok {
		return
	}
	var req struct {
		cockpitWorkflowRevisionRequest
		Decision string `json:"decision"`
		Feedback string `json:"feedback"`
	}
	if !decodeCockpitArtifactBody(w, r, &req) {
		return
	}
	command, ok := cockpitArtifactCommand(w, p, req.ExpectedRevision)
	if !ok {
		return
	}
	err := h.IssueService.ReviewCockpitArtifactVersion(r.Context(), service.CockpitArtifactReview{CockpitArtifactCommand: command, VersionID: p.VersionID, Decision: req.Decision, Feedback: req.Feedback})
	if !writeCockpitArtifactError(w, r, err) {
		h.writeCockpitArtifactVersionCommand(w, r, p, http.StatusOK)
	}
}

func (h *Handler) ListCockpitIssueArtifactContexts(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitArtifactRead(w, r, false)
	if !ok {
		return
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "issueId"))
	if !ok {
		return
	}
	if issue.WorkspaceID != p.WorkspaceID {
		writeError(w, http.StatusNotFound, "issue not found")
		return
	}
	out, err := h.IssueService.ListCockpitIssueArtifactContexts(r.Context(), p.WorkspaceID, issue.ID, p.ActorID, p.Cursor, p.PageSize)
	if !writeCockpitArtifactError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}


func cockpitArtifactNewIssue(w http.ResponseWriter, p service.CockpitArtifactRead, req *cockpitArtifactNewIssueRequest) (*service.IssueCreateParams, bool) {
	if req == nil {
		return nil, true
	}
	input := &service.IssueCreateParams{WorkspaceID: p.WorkspaceID, CreatorID: p.ActorID, CreatorType: "member", Status: "backlog", Priority: "none", Title: req.Title, Description: pgtype.Text{String: req.Description, Valid: true}}
	if req.Priority != nil {
		input.Priority = *req.Priority
	}
	if (req.AssigneeType == nil) != (req.AssigneeID == nil) {
		writeError(w, http.StatusBadRequest, "assignee_type and assignee_id must be supplied together")
		return nil, false
	}
	if req.AssigneeID != nil {
		var ok bool
		input.AssigneeID, ok = parseUUIDOrBadRequest(w, *req.AssigneeID, "assignee_id")
		if !ok {
			return nil, false
		}
		input.AssigneeType = pgtype.Text{String: *req.AssigneeType, Valid: true}
	}
	if req.DueDate != nil {
		var err error
		input.DueDate, err = util.ParseCalendarDate(*req.DueDate)
		if err != nil {
			writeError(w, http.StatusBadRequest, "due_date requires YYYY-MM-DD")
			return nil, false
		}
	}
	return input, true
}

type cockpitArtifactNewIssueRequest struct {
	cockpitActionIssueFields
	Title       string `json:"title"`
	Description string `json:"description"`
}
