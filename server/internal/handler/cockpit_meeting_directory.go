package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/service"
)

func (h *Handler) cockpitDirectoryPrincipal(w http.ResponseWriter, r *http.Request, authorize bool) (service.CockpitDirectoryRead, bool) {
	var p service.CockpitDirectoryRead
	ws := h.resolveWorkspaceID(r)
	id, ok := parseUUIDOrBadRequest(w, ws, "workspace id")
	if !ok {
		return p, false
	}
	member, ok := h.requireWorkspaceMember(w, r, ws, "workspace not found")
	if !ok {
		return p, false
	}
	p, err := resolveCockpitDirectoryPrincipal(r, id, member.UserID, authorize)
	if writeCockpitDirectoryError(w, r, err) {
		return p, false
	}
	return p, true
}

func resolveCockpitDirectoryPrincipal(r *http.Request, workspaceID, userID pgtype.UUID, authorize bool) (service.CockpitDirectoryRead, error) {
	p := service.CockpitDirectoryRead{WorkspaceID: workspaceID, CredentialOwnerID: userID}
	deny := func(message string) (service.CockpitDirectoryRead, error) {
		return p, &service.CockpitDirectoryError{Code: "task_context_required", Message: message}
	}
	switch r.Header.Get("X-Actor-Source") {
	case "":
		p.ActorSource = "human"
	case "cloud_pat":
		p.ActorSource = "cloud_pat"
		if authorize {
			return deny("A cloud-node credential can read existing plans but cannot authorize directory preparation.")
		}
	case "task_token":
		identity, trusted := middleware.TaskTokenIdentityFromContext(r.Context())
		if !trusted || identity.WorkspaceID != workspaceID || identity.UserID != userID {
			return deny("The authenticated task binding is required.")
		}
		p.ActorSource = "task_token"
		p.TaskTokenID, p.RunID, p.AgentID = identity.ID, identity.TaskID, identity.AgentID
	default:
		return deny("The authenticated principal is not supported.")
	}
	return p, nil
}

// Legacy directory and task results stay independent. Directory work always
// passes through the same durable service as the new command endpoints.
func (h *Handler) provisionLegacyCockpitDirectory(r *http.Request, cc cockpitContext, meetingID pgtype.UUID, directory string) service.CockpitLegacyDirectoryResult {
	out := service.CockpitLegacyDirectoryResult{Directory: directory}
	if h.IssueService == nil || !h.IssueService.CockpitMeetingDirectoryBackendReady {
		out.ErrorCode = "meeting_directory_unavailable"
		out.ErrorMessage = "Meeting directory services are not available."
		return out
	}
	p, err := resolveCockpitDirectoryPrincipal(r, cc.workspaceID, cc.member.UserID, true)
	if err == nil {
		p.MeetingID = meetingID
		out, err = h.IssueService.ProvisionCockpitMeetingDirectory(r.Context(), p, service.CockpitLegacyDirectoryInput{Directory: directory})
	}
	if err != nil {
		out.ErrorCode = "directory_preparation_unconfirmed"
		out.ErrorMessage = "Directory preparation could not be confirmed. Reload its recorded result before trying again."
		var typed *service.CockpitDirectoryError
		if errors.As(err, &typed) {
			out.ErrorCode = typed.Code
			out.ErrorMessage = typed.Message
		}
	}
	return out
}

func (h *Handler) cockpitDirectoryQuery(w http.ResponseWriter, r *http.Request, meeting, authorize, paged bool) (service.CockpitDirectoryQuery, bool) {
	var p service.CockpitDirectoryQuery
	if h.IssueService == nil || !h.IssueService.CockpitMeetingDirectoryBackendReady {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "meeting_directory_unavailable", "error": "Meeting directory services are not available."})
		return p, false
	}
	var ok bool
	p.CockpitDirectoryRead, ok = h.cockpitDirectoryPrincipal(w, r, authorize)
	if !ok {
		return p, false
	}
	if meeting {
		p.MeetingID, ok = parseUUIDOrBadRequest(w, chi.URLParam(r, "meetingId"), "meeting id")
		if !ok {
			return p, false
		}
	}
	keys := []string{}
	if paged {
		keys = []string{"cursor", "page_size"}
	}
	if !cockpitPreparationQueryKeys(w, r, keys...) {
		return p, false
	}
	if paged {
		p.PageSize, ok = cockpitActionPageSize(w, r)
		if !ok {
			return p, false
		}
		p.Cursor = r.URL.Query().Get("cursor")
		if len(p.Cursor) > 4096 {
			writeError(w, http.StatusBadRequest, "cursor is too long")
			return p, false
		}
	}
	for _, v := range []struct {
		name string
		dest *pgtype.UUID
	}{{"rootId", &p.RootID}, {"operationId", &p.OperationID}, {"stepId", &p.StepID}, {"attemptId", &p.AttemptID}} {
		if raw := chi.URLParam(r, v.name); raw != "" {
			*v.dest, ok = parseUUIDOrBadRequest(w, raw, v.name)
			if !ok {
				return p, false
			}
		}
	}
	return p, true
}
func decodeCockpitDirectoryBody(w http.ResponseWriter, r *http.Request, target any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "invalid directory preparation command")
		return false
	}
	if d.Decode(new(any)) != io.EOF {
		writeError(w, http.StatusBadRequest, "expected one JSON command")
		return false
	}
	return true
}
func directoryCommandID(w http.ResponseWriter, key string, revision int64) bool {
	if _, ok := parseUUIDOrBadRequest(w, key, "command_key"); !ok {
		return false
	}
	if revision < 1 {
		writeError(w, http.StatusBadRequest, "expected_revision must be positive")
		return false
	}
	return true
}
func directoryPreviewIDs(w http.ResponseWriter, in service.CockpitDirectoryPreviewInput) bool {
	if _, ok := parseUUIDOrBadRequest(w, in.RootID, "root_id"); !ok {
		return false
	}
	if in.ObservedBindingRevision < 1 {
		writeError(w, http.StatusBadRequest, "observed_binding_revision must be positive")
		return false
	}
	return true
}
func directoryStepIDs(w http.ResponseWriter, ids []string) bool {
	if len(ids) < 1 || len(ids) > 32 {
		writeError(w, http.StatusBadRequest, "step_ids must contain 1 to 32 unique UUIDs")
		return false
	}
	seen := map[pgtype.UUID]bool{}
	for _, raw := range ids {
		id, ok := parseUUIDOrBadRequest(w, raw, "step_ids")
		if !ok {
			return false
		}
		if seen[id] {
			writeError(w, http.StatusBadRequest, "step_ids must be unique")
			return false
		}
		seen[id] = true
	}
	return true
}
func writeCockpitDirectoryError(w http.ResponseWriter, r *http.Request, err error) bool {
	if err == nil {
		return false
	}
	var e *service.CockpitDirectoryError
	if !errors.As(err, &e) {
		return writeCockpitLifecycleError(w, r, err)
	}
	status := http.StatusConflict
	switch {
	case e.Code == "prepare_configuration_invalid":
		status = http.StatusServiceUnavailable
	case errors.Is(e, service.ErrCockpitWorkflowInput):
		status = http.StatusBadRequest
	case errors.Is(e, service.ErrCockpitWorkflowForbidden) || e.Code == "task_context_required":
		status = http.StatusForbidden
	case errors.Is(e, service.ErrCockpitWorkflowNotFound):
		status = http.StatusNotFound
	case errors.Is(e, service.ErrCockpitLifecycleGone):
		status = http.StatusGone
	}
	out := map[string]any{"code": e.Code, "error": e.Message, "retryable": e.Retryable}
	if e.Code == "directory_operation_exists" {
		out["workspace_id"] = e.WorkspaceID
		out["meeting_id"] = e.MeetingID
		out["root_id"] = e.RootID
		out["directory_operation_id"] = e.OperationID
		out["command_key"] = e.CommandKey
	}
	writeJSON(w, status, out)
	return true
}

func (h *Handler) ListCockpitDirectoryRoots(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitDirectoryQuery(w, r, false, true, true)
	if !ok {
		return
	}
	out, err := h.IssueService.ListCockpitDirectoryRoots(r.Context(), p)
	if !writeCockpitDirectoryError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) GetCockpitDirectoryRoot(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitDirectoryQuery(w, r, false, true, false)
	if !ok {
		return
	}
	out, err := h.IssueService.GetCockpitDirectoryRoot(r.Context(), p)
	if !writeCockpitDirectoryError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) GetCockpitMeetingDirectory(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitDirectoryQuery(w, r, true, false, false)
	if !ok {
		return
	}
	out, err := h.IssueService.GetCockpitMeetingDirectory(r.Context(), p.CockpitDirectoryRead)
	if !writeCockpitDirectoryError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) ListCockpitDirectoryOperations(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitDirectoryQuery(w, r, true, false, true)
	if !ok {
		return
	}
	out, err := h.IssueService.ListCockpitDirectoryOperations(r.Context(), p)
	if !writeCockpitDirectoryError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) GetCockpitDirectoryOperation(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitDirectoryQuery(w, r, true, false, false)
	if !ok {
		return
	}
	out, err := h.IssueService.GetCockpitDirectoryOperation(r.Context(), p)
	if !writeCockpitDirectoryError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) ListCockpitDirectorySteps(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitDirectoryQuery(w, r, true, false, false)
	if !ok {
		return
	}
	out, err := h.IssueService.ListCockpitDirectorySteps(r.Context(), p)
	if !writeCockpitDirectoryError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) ListCockpitDirectoryAttempts(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitDirectoryQuery(w, r, true, false, true)
	if !ok {
		return
	}
	out, err := h.IssueService.ListCockpitDirectoryAttempts(r.Context(), p)
	if !writeCockpitDirectoryError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) GetCockpitDirectoryAttempt(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitDirectoryQuery(w, r, true, false, false)
	if !ok {
		return
	}
	out, err := h.IssueService.GetCockpitDirectoryAttempt(r.Context(), p)
	if !writeCockpitDirectoryError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) PreviewCockpitMeetingDirectory(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitDirectoryQuery(w, r, true, true, false)
	if !ok {
		return
	}
	var in service.CockpitDirectoryPreviewInput
	if !decodeCockpitDirectoryBody(w, r, &in) || !directoryPreviewIDs(w, in) {
		return
	}
	out, err := h.IssueService.PreviewCockpitMeetingDirectory(r.Context(), p.CockpitDirectoryRead, in)
	if !writeCockpitDirectoryError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) CreateCockpitMeetingDirectory(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitDirectoryQuery(w, r, true, true, false)
	if !ok {
		return
	}
	var in service.CockpitDirectoryCreateInput
	if !decodeCockpitDirectoryBody(w, r, &in) || !directoryCommandID(w, in.CommandKey, in.ExpectedRevision) || !directoryPreviewIDs(w, in.CockpitDirectoryPreviewInput) {
		return
	}
	out, err := h.IssueService.CreateCockpitMeetingDirectory(r.Context(), p.CockpitDirectoryRead, in)
	if !writeCockpitDirectoryError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) PreviewCockpitDirectoryRetry(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitDirectoryQuery(w, r, true, true, false)
	if !ok {
		return
	}
	var in service.CockpitDirectoryRetryPreviewInput
	if !decodeCockpitDirectoryBody(w, r, &in) || !directoryStepIDs(w, in.StepIDs) {
		return
	}
	out, err := h.IssueService.PreviewCockpitDirectoryRetry(r.Context(), p, in)
	if !writeCockpitDirectoryError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) RetryCockpitDirectoryOperation(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitDirectoryQuery(w, r, true, true, false)
	if !ok {
		return
	}
	var in service.CockpitDirectoryRetryInput
	if !decodeCockpitDirectoryBody(w, r, &in) || !directoryCommandID(w, in.CommandKey, in.ExpectedRevision) || !directoryStepIDs(w, in.StepIDs) {
		return
	}
	out, err := h.IssueService.RetryCockpitDirectoryOperation(r.Context(), p, in)
	if !writeCockpitDirectoryError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) ControlCockpitDirectoryOperation(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitDirectoryQuery(w, r, true, true, false)
	if !ok {
		return
	}
	var in service.CockpitDirectoryControlInput
	if !decodeCockpitDirectoryBody(w, r, &in) || !directoryCommandID(w, in.CommandKey, in.ExpectedRevision) {
		return
	}
	out, err := h.IssueService.ControlCockpitDirectoryOperation(r.Context(), p, in)
	if !writeCockpitDirectoryError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
