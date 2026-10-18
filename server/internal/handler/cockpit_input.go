package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/service"
)

// Input transport never infers a human identity from an Agent or task header.
// The task-token tuple was established by authentication, not supplied by JSON.
func resolveCockpitInputPrincipal(r *http.Request, ws, user pgtype.UUID) (service.CockpitInputRead, error) {
	p := service.CockpitInputRead{WorkspaceID: ws, CredentialOwnerID: user}
	switch r.Header.Get("X-Actor-Source") {
	case "":
		p.ActorSource = "human"
	case "cloud_pat":
		p.ActorSource = "cloud_pat"
	case "task_token":
		id, ok := middleware.TaskTokenIdentityFromContext(r.Context())
		if !ok || id.WorkspaceID != ws || id.UserID != user {
			return p, &service.CockpitInputError{Code: "task_context_required", Message: "The authenticated task binding is required."}
		}
		p.ActorSource = "task_token"
		p.AgentID = id.AgentID
		p.RunID = id.TaskID
		p.TaskTokenID = id.ID
	default:
		return p, &service.CockpitInputError{Code: "task_context_required", Message: "The authenticated principal is not supported."}
	}
	return p, nil
}
func (h *Handler) cockpitInputAPI(w http.ResponseWriter, run bool) (service.CockpitInputAPI, bool) {
	ready := h.IssueService != nil
	if ready {
		if run {
			ready = h.IssueService.CockpitRunInputManifestBackendReady
		} else {
			ready = h.IssueService.CockpitInputBackendReady
		}
	}
	// The complete domain interface is required, even if a capability was set
	// incorrectly during configuration. This is not a fallback implementation.
	api, implemented := any(h.IssueService).(service.CockpitInputAPI)
	if !ready || !implemented {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "inputs_unavailable", "error": "Input services are not available."})
		return nil, false
	}
	return api, true
}
func (h *Handler) cockpitInputRequest(w http.ResponseWriter, r *http.Request, keys ...string) (service.CockpitInputAPI, service.CockpitInputQuery, bool) {
	return h.cockpitInputScopedRequest(w, r, false, keys...)
}
func (h *Handler) cockpitInputScopedRequest(w http.ResponseWriter, r *http.Request, run bool, keys ...string) (service.CockpitInputAPI, service.CockpitInputQuery, bool) {
	var q service.CockpitInputQuery
	api, ok := h.cockpitInputAPI(w, run)
	if !ok {
		return nil, q, false
	}

	if daemonWS := middleware.DaemonWorkspaceIDFromContext(r.Context()); daemonWS != "" {
		ws, ok := parseUUIDOrBadRequest(w, daemonWS, "workspace_id")
		if !ok {
			return nil, q, false
		}
		if supplied := r.Header.Get("X-Workspace-ID"); supplied != "" && supplied != daemonWS {
			writeError(w, http.StatusForbidden, "workspace does not match the daemon credential")
			return nil, q, false
		}
		if r.Header.Get("X-Workspace-Slug") != "" {
			writeError(w, http.StatusBadRequest, "daemon claims use their exact workspace identity")
			return nil, q, false
		}
		q.CockpitInputRead = service.CockpitInputRead{WorkspaceID: ws, ActorSource: "daemon_claim"}
	} else {
		ws, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace_id")
		if !ok {
			return nil, q, false
		}
		member, ok := h.requireWorkspaceMember(w, r, uuidToString(ws), "input not found")
		if !ok {
			return nil, q, false
		}
		p, err := resolveCockpitInputPrincipal(r, ws, member.UserID)
		if writeCockpitInputError(w, r, err) {
			return nil, q, false
		}
		q.CockpitInputRead = p
	}
	for _, entry := range []struct {
		name string
		dst  *pgtype.UUID
	}{
		{"inputId", &q.InputID}, {"versionId", &q.VersionID}, {"transferId", &q.TransferID}, {"referenceId", &q.ReferenceID}, {"meetingId", &q.MeetingID}, {"agendaId", &q.AgendaID}, {"issueId", &q.IssueID}, {"commandKey", &q.CommandKey}, {"manifestVersionId", &q.ManifestVersionID},
	} {
		if raw := chi.URLParam(r, entry.name); raw != "" {
			*entry.dst, ok = parseUUIDOrBadRequest(w, raw, entry.name)
			if !ok {
				return nil, q, false
			}
		}
	}
	if !parseCockpitInputQuery(w, r, &q, keys...) {
		return nil, q, false
	}
	return api, q, true
}
func parseCockpitInputQuery(w http.ResponseWriter, r *http.Request, q *service.CockpitInputQuery, keys ...string) bool {
	allowed := map[string]bool{}
	for _, key := range keys {
		allowed[key] = true
	}
	values, queryErr := url.ParseQuery(r.URL.RawQuery)
	if queryErr != nil {
		return inputBodyError(w, "invalid query encoding")
	}
	for key, vs := range values {
		if !allowed[key] || (key != "ids" && len(vs) != 1) {
			writeError(w, http.StatusBadRequest, "unsupported or repeated query parameter: "+key)
			return false
		}
	}
	q.PageSize = service.CockpitInputPageSize
	if raw := values.Get("page_size"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 32)
		if err != nil || n < 1 || n > service.CockpitInputMaxPageSize {
			writeError(w, http.StatusBadRequest, "page_size must be between 1 and 100")
			return false
		}
		q.PageSize = int32(n)
	}
	q.Cursor = values.Get("cursor")
	if len(q.Cursor) > 4096 {
		writeError(w, http.StatusBadRequest, "cursor is too long")
		return false
	}
	q.Scope.Query = values.Get("q")
	if len(q.Scope.Query) > 512 {
		writeError(w, http.StatusBadRequest, "q is too long")
		return false
	}
	q.Scope.Archive = "active"
	if raw := values.Get("archive"); raw != "" {
		if raw != "active" && raw != "archived" && raw != "all" {
			writeError(w, http.StatusBadRequest, "invalid archive filter")
			return false
		}
		q.Scope.Archive = raw
	}
	q.Scope.SourceKind = values.Get("source_kind")
	if raw := q.Scope.SourceKind; raw != "" && raw != "upload" && raw != "nas_file" && raw != "attachment" && raw != "artifact_version" {
		writeError(w, http.StatusBadRequest, "invalid source_kind")
		return false
	}
	for _, entry := range []struct {
		name string
		dst  **string
	}{{"project_id", &q.Scope.ProjectID}, {"meeting_id", &q.Scope.MeetingID}, {"agenda_id", &q.Scope.AgendaID}, {"origin_issue_id", &q.Scope.OriginIssueID}} {
		if vs, present := values[entry.name]; present {
			if _, ok := parseUUIDOrBadRequest(w, vs[0], entry.name); !ok {
				return false
			}
			raw := vs[0]
			*entry.dst = &raw
		}
	}
	q.Scope.IDs = values["ids"]
	if q.Scope.IDs == nil {
		q.Scope.IDs = []string{}
	}
	if !cockpitInputIDs(w, q.Scope.IDs, 0, 100, "ids") {
		return false
	}
	if raw, present := values["include_removed"]; present {
		if raw[0] != "true" && raw[0] != "false" {
			writeError(w, http.StatusBadRequest, "include_removed must be true or false")
			return false
		}
		q.IncludeRemoved = raw[0] == "true"
	}
	if raw := values.Get("agenda_id"); raw != "" && q.MeetingID.Valid {
		q.AgendaID, _ = parseUUIDOrBadRequest(w, raw, "agenda_id")
	}
	q.Purpose = values.Get("purpose")
	if q.Purpose != "" && q.Purpose != "material" && q.Purpose != "recording" && q.Purpose != "supporting" {
		writeError(w, http.StatusBadRequest, "invalid purpose")
		return false
	}
	return true
}
func cockpitInputIDs(w http.ResponseWriter, ids []string, min, max int, name string) bool {
	if len(ids) < min || len(ids) > max {
		writeError(w, http.StatusBadRequest, "invalid "+name+" count")
		return false
	}
	seen := map[pgtype.UUID]bool{}
	for _, raw := range ids {
		id, ok := parseUUIDOrBadRequest(w, raw, name)
		if !ok {
			return false
		}
		if seen[id] {
			writeError(w, http.StatusBadRequest, name+" must be unique")
			return false
		}
		seen[id] = true
	}
	return true
}
func decodeCockpitInputBody(w http.ResponseWriter, r *http.Request, target any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10))
	var raw json.RawMessage
	if err := d.Decode(&raw); err != nil {
		writeError(w, http.StatusBadRequest, "invalid input command")
		return false
	}
	if d.Decode(new(any)) != io.EOF {
		writeError(w, http.StatusBadRequest, "expected one JSON command")
		return false
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return inputBodyError(w, "expected a JSON object")
	}
	required := []string{}
	switch target.(type) {
	case *service.CockpitInputCreateInput:
		required = []string{"command_key", "title", "description"}
	case *service.CockpitInputEditInput:
		required = []string{"expected_revision", "title", "description"}
	case *service.CockpitInputArchiveInput:
		required = []string{"expected_revision", "archived"}
	case *service.CockpitInputVersionSubmitInput:
		required = []string{"command_key", "expected_revision", "source"}
	case *service.CockpitInputRestartInput:
		required = []string{"command_key", "expected_revision", "mode"}
	case *service.CockpitInputFinalizeInput:
		required = []string{"command_key", "expected_revision", "expected_content_hash"}
	case *service.CockpitInputAbandonInput:
		required = []string{"command_key", "expected_revision", "reason"}
	case *service.CockpitInputReferenceCreateInput:
		required = []string{"command_key", "input_version_id", "purpose"}
	case *service.CockpitInputReferenceRemoveInput:
		required = []string{"command_key"}
	case *service.CockpitInputManifestSaveInput:
		required = []string{"command_key", "expected_revision", "items", "note"}
	case *service.CockpitRunInputPreparationInput:
		required = []string{"manifest_version_id", "manifest_hash", "dispatched_at", "state", "prepared_input_version_ids", "error_code"}
	}
	for _, name := range required {
		v, ok := fields[name]
		if !ok || string(v) == "null" {
			return inputBodyError(w, "missing "+name)
		}
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil {
		return inputBodyError(w, "invalid input command")
	}
	return validateCockpitInputBody(w, target)
}
func writeCockpitInputError(w http.ResponseWriter, r *http.Request, err error) bool {
	if err == nil {
		return false
	}
	var e *service.CockpitInputError
	if !errors.As(err, &e) {
		return writeCockpitLifecycleError(w, r, err)
	}
	status := http.StatusConflict
	switch {
	case e.Code == "input_io_busy":
		status = http.StatusTooManyRequests
		w.Header().Set("Retry-After", "1")
	case e.Code == "storage_unavailable":
		status = http.StatusServiceUnavailable
	case e.Code == "task_context_required" || errors.Is(err, service.ErrCockpitWorkflowForbidden):
		status = http.StatusForbidden
	case errors.Is(err, service.ErrCockpitWorkflowInput):
		status = http.StatusBadRequest
	case errors.Is(err, service.ErrCockpitWorkflowNotFound):
		status = http.StatusNotFound
	case errors.Is(err, service.ErrCockpitLifecycleGone):
		status = http.StatusGone
	}
	writeJSON(w, status, map[string]any{"code": e.Code, "error": e.Message, "retryable": e.Retryable, "workspace_id": e.WorkspaceID, "input_id": e.InputID, "version_id": e.VersionID, "transfer_id": e.TransferID, "existing_reference_id": e.ExistingReferenceID})
	return true
}
func writeCockpitInputResult(w http.ResponseWriter, r *http.Request, out any, err error) {
	if !writeCockpitInputError(w, r, err) {
		w.Header().Set("Cache-Control", "private, no-store")
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) GetCockpitInputCapabilities(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	out, err := api.GetCockpitInputCapabilities(r.Context(), q.CockpitInputRead)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) ListCockpitInputs(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r, "cursor", "page_size", "ids", "project_id", "meeting_id", "agenda_id", "origin_issue_id", "q", "archive", "source_kind")
	if !ok {
		return
	}
	out, err := api.ListCockpitInputs(r.Context(), q)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) GetCockpitInput(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	out, err := api.GetCockpitInput(r.Context(), q)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) GetCockpitInputCreateCommand(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	out, err := api.GetCockpitInputCreateCommand(r.Context(), q)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) ListCockpitInputVersions(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r, "cursor", "page_size")
	if !ok {
		return
	}
	out, err := api.ListCockpitInputVersions(r.Context(), q)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) GetCockpitInputVersion(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	out, err := api.GetCockpitInputVersion(r.Context(), q)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) GetCockpitInputVersionCommand(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	out, err := api.GetCockpitInputVersionCommand(r.Context(), q)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) ListCockpitInputTransfers(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r, "cursor", "page_size")
	if !ok {
		return
	}
	out, err := api.ListCockpitInputTransfers(r.Context(), q)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) GetCockpitInputTransfer(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	out, err := api.GetCockpitInputTransfer(r.Context(), q)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) GetCockpitInputTransferCommand(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	out, err := api.GetCockpitInputTransferCommand(r.Context(), q)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) VerifyCockpitInputVersion(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	out, err := api.VerifyCockpitInputVersion(r.Context(), q)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) GetCockpitInputManifest(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	out, err := api.GetCockpitInputManifest(r.Context(), q)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) GetCockpitInputManifestCommand(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	out, err := api.GetCockpitInputManifestCommand(r.Context(), q)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) ListCockpitInputManifestVersions(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r, "cursor", "page_size")
	if !ok {
		return
	}
	out, err := api.ListCockpitInputManifestVersions(r.Context(), q)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) GetCockpitInputManifestVersion(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	out, err := api.GetCockpitInputManifestVersion(r.Context(), q)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) ListCockpitInputManifestItems(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r, "cursor", "page_size", "task_id", "runtime_id", "dispatched_at")
	if !ok {
		return
	}
	if !h.cockpitInputOptionalClaim(w, r, &q) {
		return
	}
	out, err := api.ListCockpitInputManifestItems(r.Context(), q)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) ListCockpitInputSpaces(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	out, err := api.ListCockpitInputSpaces(r.Context(), q.CockpitInputRead)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) CreateCockpitInput(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	var in service.CockpitInputCreateInput
	if !decodeCockpitInputBody(w, r, &in) {
		return
	}
	out, err := api.CreateCockpitInput(r.Context(), q.CockpitInputRead, in)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) EditCockpitInput(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	var in service.CockpitInputEditInput
	if !decodeCockpitInputBody(w, r, &in) {
		return
	}
	out, err := api.EditCockpitInput(r.Context(), q, in)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) ArchiveCockpitInput(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	var in service.CockpitInputArchiveInput
	if !decodeCockpitInputBody(w, r, &in) {
		return
	}
	out, err := api.ArchiveCockpitInput(r.Context(), q, in)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) SubmitCockpitInputVersion(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	var in service.CockpitInputVersionSubmitInput
	if !decodeCockpitInputBody(w, r, &in) {
		return
	}
	out, err := api.SubmitCockpitInputVersion(r.Context(), q, in)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) RestartCockpitInputTransfer(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	var in service.CockpitInputRestartInput
	if !decodeCockpitInputBody(w, r, &in) {
		return
	}
	out, err := api.RestartCockpitInputTransfer(r.Context(), q, in)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) FinalizeCockpitInputTransfer(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	var in service.CockpitInputFinalizeInput
	if !decodeCockpitInputBody(w, r, &in) {
		return
	}
	out, err := api.FinalizeCockpitInputTransfer(r.Context(), q, in)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) AbandonCockpitInputTransfer(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	var in service.CockpitInputAbandonInput
	if !decodeCockpitInputBody(w, r, &in) {
		return
	}
	out, err := api.AbandonCockpitInputTransfer(r.Context(), q, in)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) SaveCockpitInputManifest(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	var in service.CockpitInputManifestSaveInput
	if !decodeCockpitInputBody(w, r, &in) {
		return
	}
	out, err := api.SaveCockpitInputManifest(r.Context(), q, in)
	writeCockpitInputResult(w, r, out, err)
}

func (h *Handler) GetCockpitInputVersionBatch(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r, "ids")
	if !ok || !cockpitInputIDs(w, q.Scope.IDs, 1, 100, "ids") {
		return
	}
	out, err := api.GetCockpitInputVersionBatch(r.Context(), q.CockpitInputRead, q.Scope.IDs)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) BrowseCockpitInputSpace(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	root, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "rootId"), "root_id")
	if !ok {
		return
	}
	var in service.CockpitInputNASBrowseInput
	if !decodeCockpitInputBody(w, r, &in) {
		return
	}
	out, err := api.BrowseCockpitInputSpace(r.Context(), q.CockpitInputRead, uuidToString(root), in)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) UploadCockpitInputBytes(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r)
	if !ok {
		return
	}
	if r.Header.Get("Content-Type") != "application/octet-stream" {
		writeError(w, http.StatusUnsupportedMediaType, "expected application/octet-stream")
		return
	}
	values := r.Header.Values("X-Input-Transfer-Revision")
	if len(values) != 1 || strings.Trim(values[0], "0123456789") != "" || values[0] == "" {
		writeError(w, http.StatusBadRequest, "expected one positive transfer revision")
		return
	}
	revision, err := strconv.ParseInt(values[0], 10, 64)
	if err != nil || revision < 1 {
		writeError(w, http.StatusBadRequest, "invalid transfer revision")
		return
	}
	if r.ContentLength > service.CockpitInputMaxFileBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "input exceeds the upload limit")
		return
	}
	r, finish, ok := cockpitInputStreamDeadline(w, r, true)
	if !ok {
		return
	}
	defer finish(false)
	// The service authorizes and claims this exact session before it reads bytes.
	reader := http.MaxBytesReader(w, r.Body, service.CockpitInputMaxFileBytes)
	out, err := api.UploadCockpitInputBytes(r.Context(), q, revision, reader)
	finish(err == nil)
	writeCockpitInputResult(w, r, out, err)
}

func (h *Handler) ListCockpitInputAttachments(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r, "cursor", "page_size", "q")
	if !ok {
		return
	}
	out, err := api.ListCockpitInputAttachments(r.Context(), q)
	writeCockpitInputResult(w, r, out, err)
}
