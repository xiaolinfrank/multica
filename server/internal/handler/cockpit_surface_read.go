package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
)

// Surface reads never initialize a cockpit or perform external I/O.
func (h *Handler) cockpitSurfaceQuery(w http.ResponseWriter, r *http.Request) (service.CockpitSurfaceQuery, bool) {
	var out service.CockpitSurfaceQuery
	ws := h.resolveWorkspaceID(r)
	id, ok := parseUUIDOrBadRequest(w, ws, "workspace id")
	if !ok {
		return out, false
	}
	member, ok := h.requireWorkspaceMember(w, r, ws, "workspace not found")
	if !ok {
		return out, false
	}
	var project, module pgtype.UUID
	if ref := r.URL.Query().Get("project_id"); ref != "" {
		project, ok = parseUUIDOrBadRequest(w, ref, "project_id")
		if !ok {
			return out, false
		}
	}
	if ref := r.URL.Query().Get("module_id"); ref != "" {
		module, ok = parseUUIDOrBadRequest(w, ref, "module_id")
		if !ok {
			return out, false
		}
	}
	return service.CockpitSurfaceQuery{WorkspaceID: id, ProjectID: project, ModuleID: module, ActorID: member.UserID, Human: !isMachineCredentialActor(r),
		MeetingLifecycleAvailable:   h.IssueService != nil && h.IssueService.CockpitMeetingLifecycleBackendReady,
		MeetingTemplatesAvailable:   h.IssueService != nil && h.IssueService.CockpitMeetingTemplatesBackendReady,
		MeetingDispositionAvailable: h.IssueService != nil && h.IssueService.CockpitMeetingDispositionBackendReady,
		ArtifactsAvailable:          h.IssueService != nil && h.IssueService.CockpitArtifactBackendReady && r.URL.Query().Get("client_contract") == "artifacts-v1"}, true
}
func writeCockpitSurfaceError(w http.ResponseWriter, r *http.Request, err error) bool {
	if errors.Is(err, service.ErrCockpitIndexLimit) {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": err.Error(), "code": "display_index_limit"})
		return true
	}
	if errors.Is(err, service.ErrCockpitScopeLimit) {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": err.Error(), "code": "scope_limit"})
		return true
	}
	return writeCockpitActionError(w, r, err)
}
func (h *Handler) GetCockpitSurfaceContext(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	out, err := h.IssueService.GetCockpitSurfaceContext(r.Context(), p)
	if !writeCockpitSurfaceError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) GetCockpitPlanSurface(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	out, err := h.IssueService.GetCockpitPlanSurface(r.Context(), p)
	if !writeCockpitSurfaceError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) GetCockpitNodeIndex(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	out, err := h.IssueService.GetCockpitNodeIndex(r.Context(), p)
	if !writeCockpitSurfaceError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) listCockpitScopeChoices(w http.ResponseWriter, r *http.Request, kind string) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	out, err := h.IssueService.ListCockpitScopeChoices(r.Context(), p, kind, r.URL.Query().Get("q"), r.URL.Query().Get("cursor"))
	if !writeCockpitSurfaceError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) ListCockpitScopeProjects(w http.ResponseWriter, r *http.Request) {
	h.listCockpitScopeChoices(w, r, "projects")
}
func (h *Handler) ListCockpitScopeModules(w http.ResponseWriter, r *http.Request) {
	h.listCockpitScopeChoices(w, r, "modules")
}

func (h *Handler) ListCockpitMeetingRegister(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	size, ok := cockpitActionPageSize(w, r)
	if !ok {
		return
	}
	v := r.URL.Query()
	var nodeID pgtype.UUID
	var nodeIDs []pgtype.UUID
	if len(v["node_ids"]) > 200 {
		writeError(w, http.StatusBadRequest, "at most 200 node_ids")
		return
	}
	for _, ref := range v["node_ids"] {
		id, valid := parseUUIDOrBadRequest(w, ref, "node_ids")
		if !valid {
			return
		}
		nodeIDs = append(nodeIDs, id)
	}
	if ref := v.Get("node_id"); ref != "" {
		nodeID, ok = parseUUIDOrBadRequest(w, ref, "node_id")
		if !ok {
			return
		}
	}
	out, err := h.IssueService.ListCockpitMeetingRegister(r.Context(), service.CockpitMeetingRegisterQuery{
		CockpitSurfaceQuery: p, NodeID: nodeID, NodeIDs: nodeIDs, Archive: v.Get("archive"), Query: v.Get("q"), WorkflowStage: v.Get("workflow_stage"), DateFrom: v.Get("date_from"), DateTo: v.Get("date_to"), Cursor: v.Get("cursor"), PageSize: size,
		Tracks: v["tracks"], Kinds: v["kinds"], Statuses: v["statuses"], Parties: v["parties"], Only: v["only"],
	})
	if !writeCockpitSurfaceError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) GetCockpitSurfaceNode(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "node id")
	if !ok {
		return
	}
	out, err := h.IssueService.GetCockpitSurfaceNode(r.Context(), p, id)
	if !writeCockpitSurfaceError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) GetCockpitSurfaceMeeting(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "meetingId"), "meeting id")
	if !ok {
		return
	}
	out, err := h.IssueService.GetCockpitSurfaceMeeting(r.Context(), p, id)
	if !writeCockpitSurfaceError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) listCockpitSurfaceObjectPage(w http.ResponseWriter, r *http.Request, kind string) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	// Relationship continuations belong to the object, independent of screen filters.
	if p.ProjectID.Valid || p.ModuleID.Valid {
		writeError(w, http.StatusBadRequest, "object relation pages do not accept project or module filters")
		return
	}
	ref := chi.URLParam(r, "meetingId")
	if kind == "payments" {
		ref = chi.URLParam(r, "id")
	}
	id, ok := parseUUIDOrBadRequest(w, ref, "object id")
	if !ok {
		return
	}
	size, ok := cockpitActionPageSize(w, r)
	if !ok {
		return
	}
	out, err := h.IssueService.ListCockpitSurfaceObjectPage(r.Context(), p, id, kind, r.URL.Query().Get("cursor"), size)
	if !writeCockpitSurfaceError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) ListCockpitNodePayments(w http.ResponseWriter, r *http.Request) {
	h.listCockpitSurfaceObjectPage(w, r, "payments")
}
func (h *Handler) ListCockpitMeetingIssuePage(w http.ResponseWriter, r *http.Request) {
	h.listCockpitSurfaceObjectPage(w, r, "meeting_issues")
}
func (h *Handler) ListCockpitMeetingNodePage(w http.ResponseWriter, r *http.Request) {
	h.listCockpitSurfaceObjectPage(w, r, "meeting_nodes")
}
func (h *Handler) ListCockpitNodeMeetings(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	if p.ProjectID.Valid || p.ModuleID.Valid {
		writeError(w, http.StatusBadRequest, "object relation pages do not accept project or module filters")
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "node id")
	if !ok {
		return
	}
	size, ok := cockpitActionPageSize(w, r)
	if !ok {
		return
	}
	out, err := h.IssueService.ListCockpitMeetingRegister(r.Context(), service.CockpitMeetingRegisterQuery{CockpitSurfaceQuery: p, NodeID: id, Cursor: r.URL.Query().Get("cursor"), PageSize: size, Archive: defaultCockpitArchive(r.URL.Query().Get("archive"), "all")})
	if !writeCockpitSurfaceError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) GetCockpitMeetingNextCode(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	out, err := h.IssueService.GetCockpitMeetingNextCode(r.Context(), p, r.URL.Query().Get("date"))
	if !writeCockpitSurfaceError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

// The bounded read uses a body because grouped row filters can exceed proxy URL limits.
func (h *Handler) GetCockpitPlanMeetingMarkers(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 128<<10)
	var body struct {
		Archive  string                         `json:"archive"`
		Rows     []service.CockpitPlanMarkerRow `json:"rows"`
		DateFrom string                         `json:"date_from"`
		DateTo   string                         `json:"date_to"`
		Cursor   string                         `json:"cursor"`
	}
	if _, ok := decodeCockpitBody(w, r, &body); !ok {
		return
	}
	if len(body.Rows) > 100 {
		writeError(w, http.StatusBadRequest, "at most 100 marker rows")
		return
	}
	for i, row := range body.Rows {
		for j, value := range row.NodeIDs {
			id, valid := parseUUIDOrBadRequest(w, value, "rows.node_ids")
			if !valid {
				return
			}
			body.Rows[i].NodeIDs[j] = uuidToString(id)
		}
	}
	out, err := h.IssueService.GetCockpitPlanMeetingMarkers(r.Context(), service.CockpitPlanMarkerQuery{CockpitSurfaceQuery: p, Rows: body.Rows, DateFrom: body.DateFrom, DateTo: body.DateTo, Cursor: body.Cursor, Archive: body.Archive})
	if !writeCockpitSurfaceError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func defaultCockpitArchive(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
