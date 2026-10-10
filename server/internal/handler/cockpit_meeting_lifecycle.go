package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
)

func (h *Handler) cockpitLifecycleRead(w http.ResponseWriter, r *http.Request, write bool) (service.CockpitLifecycleRead, bool) {
	var p service.CockpitLifecycleRead
	if h.IssueService == nil || !h.IssueService.CockpitMeetingLifecycleBackendReady {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "meeting_lifecycle_unavailable", "error": "meeting lifecycle services are not available"})
		return p, false
	}
	ws := h.resolveWorkspaceID(r)
	id, ok := parseUUIDOrBadRequest(w, ws, "workspace id")
	if !ok {
		return p, false
	}
	member, ok := h.requireWorkspaceMember(w, r, ws, "workspace not found")
	if !ok {
		return p, false
	}
	meeting, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "meetingId"), "meeting id")
	if !ok {
		return p, false
	}
	human := !isMachineCredentialActor(r)
	if write && !human {
		writeError(w, http.StatusForbidden, "a human member must confirm this meeting command")
		return p, false
	}
	return service.CockpitLifecycleRead{WorkspaceID: id, MeetingID: meeting, ActorID: member.UserID, Human: human}, true
}
func decodeCockpitLifecycleBody(w http.ResponseWriter, r *http.Request, target any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10))
	d.DisallowUnknownFields()
	if e := d.Decode(target); e != nil {
		writeError(w, http.StatusBadRequest, "invalid meeting lifecycle command")
		return false
	}
	if d.Decode(new(any)) != io.EOF {
		writeError(w, http.StatusBadRequest, "expected one JSON command")
		return false
	}
	return true
}
func lifecycleCommandID(w http.ResponseWriter, in service.CockpitLifecycleCommandInput) bool {
	_, ok := parseUUIDOrBadRequest(w, in.CommandKey, "command_key")
	if !ok {
		return false
	}
	if in.ExpectedRevision < 1 {
		writeError(w, http.StatusBadRequest, "expected_revision must be positive")
		return false
	}
	return true
}
func lifecycleOptionalUUID(w http.ResponseWriter, s *string, field string) bool {
	if s == nil {
		return true
	}
	_, ok := parseUUIDOrBadRequest(w, *s, field)
	return ok
}
func lifecycleRawUUID(w http.ResponseWriter, raw json.RawMessage, field string) bool {
	if len(raw) == 0 || string(raw) == "null" {
		return true
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		writeError(w, http.StatusBadRequest, field+" must be a UUID or null")
		return false
	}
	return lifecycleOptionalUUID(w, &s, field)
}
func writeCockpitLifecycleError(w http.ResponseWriter, r *http.Request, e error) bool {
	if errors.Is(e, service.ErrCockpitLifecycleGone) {
		writeJSON(w, http.StatusGone, map[string]string{"error": e.Error(), "code": "command_target_gone"})
		return true
	}
	var ref *service.CockpitAgendaReferenceExistsError
	if errors.As(e, &ref) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": e.Error(), "code": "reference_exists", "existing_reference_id": ref.ReferenceID})
		return true
	}
	return writeCockpitActionError(w, r, e)
}
func (h *Handler) GetCockpitMeetingLifecycle(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitLifecycleRead(w, r, false)
	if !ok {
		return
	}
	out, e := h.IssueService.GetCockpitMeetingLifecycle(r.Context(), p)
	if !writeCockpitLifecycleError(w, r, e) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) ChangeCockpitMeetingOccurrence(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitLifecycleRead(w, r, true)
	if !ok {
		return
	}
	var in service.CockpitOccurrenceInput
	if !decodeCockpitLifecycleBody(w, r, &in) || !lifecycleCommandID(w, in.CockpitLifecycleCommandInput) {
		return
	}
	out, e := h.IssueService.ChangeCockpitMeetingOccurrence(r.Context(), p, in)
	if !writeCockpitLifecycleError(w, r, e) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) ConfirmCockpitMeetingMaterials(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitLifecycleRead(w, r, true)
	if !ok {
		return
	}
	var in service.CockpitMaterialsInput
	if !decodeCockpitLifecycleBody(w, r, &in) || !lifecycleCommandID(w, in.CockpitLifecycleCommandInput) {
		return
	}
	out, e := h.IssueService.ConfirmCockpitMeetingMaterials(r.Context(), p, in)
	if !writeCockpitLifecycleError(w, r, e) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) cockpitLifecycleList(w http.ResponseWriter, r *http.Request) (service.CockpitLifecycleList, bool) {
	p, ok := h.cockpitLifecycleRead(w, r, false)
	if !ok {
		return service.CockpitLifecycleList{}, false
	}
	size, ok := cockpitActionPageSize(w, r)
	if !ok {
		return service.CockpitLifecycleList{}, false
	}
	out := service.CockpitLifecycleList{CockpitLifecycleRead: p, PageSize: size, Query: r.URL.Query().Get("q"), Cursor: r.URL.Query().Get("cursor")}
	if v := r.URL.Query().Get("include_removed"); v != "" {
		b, e := strconv.ParseBool(v)
		if e != nil {
			writeError(w, http.StatusBadRequest, "include_removed must be boolean")
			return out, false
		}
		out.IncludeRemoved = b
	}
	if v := chi.URLParam(r, "agendaId"); v != "" {
		out.AgendaID, ok = parseUUIDOrBadRequest(w, v, "agenda id")
		if !ok {
			return out, false
		}
	}
	return out, true
}
func (h *Handler) ListCockpitMeetingAgenda(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitLifecycleList(w, r)
	if !ok {
		return
	}
	out, e := h.IssueService.ListCockpitMeetingAgenda(r.Context(), p)
	if !writeCockpitLifecycleError(w, r, e) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) GetCockpitMeetingAgenda(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitLifecycleRead(w, r, false)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "agendaId"), "agenda id")
	if !ok {
		return
	}
	out, e := h.IssueService.GetCockpitMeetingAgenda(r.Context(), p, id)
	if !writeCockpitLifecycleError(w, r, e) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) SaveCockpitMeetingAgenda(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitLifecycleRead(w, r, true)
	if !ok {
		return
	}
	var id pgtype.UUID
	if raw := chi.URLParam(r, "agendaId"); raw != "" {
		id, ok = parseUUIDOrBadRequest(w, raw, "agenda id")
		if !ok {
			return
		}
	}
	var in service.CockpitAgendaInput
	if !decodeCockpitLifecycleBody(w, r, &in) || !lifecycleCommandID(w, in.CockpitLifecycleCommandInput) || !lifecycleRawUUID(w, in.NodeID, "node_id") || !lifecycleRawUUID(w, in.FacilitatorUserID, "facilitator_user_id") {
		return
	}
	out, e := h.IssueService.SaveCockpitMeetingAgenda(r.Context(), p, id, in)
	if !writeCockpitLifecycleError(w, r, e) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) RemoveCockpitMeetingAgenda(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitLifecycleRead(w, r, true)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "agendaId"), "agenda id")
	if !ok {
		return
	}
	var in service.CockpitAgendaRemoveInput
	if !decodeCockpitLifecycleBody(w, r, &in) || !lifecycleCommandID(w, in.CockpitLifecycleCommandInput) {
		return
	}
	out, e := h.IssueService.RemoveCockpitMeetingAgenda(r.Context(), p, id, in)
	if !writeCockpitLifecycleError(w, r, e) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) ListCockpitMeetingAgendaReferences(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitLifecycleList(w, r)
	if !ok {
		return
	}
	out, e := h.IssueService.ListCockpitMeetingAgendaReferences(r.Context(), p)
	if !writeCockpitLifecycleError(w, r, e) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) AttachCockpitAgendaReference(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitLifecycleRead(w, r, true)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "agendaId"), "agenda id")
	if !ok {
		return
	}
	var in service.CockpitAgendaReferenceInput
	if !decodeCockpitLifecycleBody(w, r, &in) || !lifecycleCommandID(w, in.CockpitLifecycleCommandInput) {
		return
	}
	if _, ok = parseUUIDOrBadRequest(w, in.TargetID, "target_id"); !ok {
		return
	}
	out, e := h.IssueService.AttachCockpitAgendaReference(r.Context(), p, id, in)
	if !writeCockpitLifecycleError(w, r, e) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) RemoveCockpitAgendaReference(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitLifecycleRead(w, r, true)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "agendaId"), "agenda id")
	if !ok {
		return
	}
	ref, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "referenceId"), "reference id")
	if !ok {
		return
	}
	var in service.CockpitLifecycleCommandInput
	if !decodeCockpitLifecycleBody(w, r, &in) || !lifecycleCommandID(w, in) {
		return
	}
	out, e := h.IssueService.RemoveCockpitAgendaReference(r.Context(), p, id, ref, in)
	if !writeCockpitLifecycleError(w, r, e) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) CreateCockpitMeetingPreparationIssue(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitLifecycleRead(w, r, true)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "agendaId"), "agenda id")
	if !ok {
		return
	}
	var in service.CockpitPreparationIssueInput
	if !decodeCockpitLifecycleBody(w, r, &in) || !lifecycleCommandID(w, in.CockpitLifecycleCommandInput) {
		return
	}
	for field, value := range map[string]*string{"primary_node_id": in.PrimaryNodeID, "new_issue.project_id": in.NewIssue.ProjectID, "new_issue.module_id": in.NewIssue.ModuleID, "new_issue.assignee_id": in.NewIssue.AssigneeID} {
		if !lifecycleOptionalUUID(w, value, field) {
			return
		}
	}
	out, e := h.IssueService.CreateCockpitMeetingPreparationIssue(r.Context(), p, id, in, service.IssueCreateOpts{ActorID: uuidToString(p.ActorID)})
	if !writeCockpitLifecycleError(w, r, e) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) ListCockpitMeetingLifecycleCommands(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitLifecycleList(w, r)
	if !ok {
		return
	}
	out, e := h.IssueService.ListCockpitMeetingLifecycleCommands(r.Context(), p)
	if !writeCockpitLifecycleError(w, r, e) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) GetCockpitMeetingLifecycleCommand(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitLifecycleRead(w, r, false)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "commandKey"), "command key")
	if !ok {
		return
	}
	out, e := h.IssueService.GetCockpitMeetingLifecycleCommand(r.Context(), p, id)
	if !writeCockpitLifecycleError(w, r, e) {
		writeJSON(w, http.StatusOK, out)
	}
}
