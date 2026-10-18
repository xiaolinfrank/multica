package handler

import (
	"github.com/go-chi/chi/v5"
	"net/http"
)

func (h *Handler) ListCockpitIssueNodeReferences(w http.ResponseWriter, r *http.Request) {
	h.listCockpitIssueReferences(w, r, "nodes")
}
func (h *Handler) ListCockpitIssueMeetingReferences(w http.ResponseWriter, r *http.Request) {
	h.listCockpitIssueReferences(w, r, "meetings")
}
func (h *Handler) listCockpitIssueReferences(w http.ResponseWriter, r *http.Request, kind string) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "issueId"))
	if !ok {
		return
	}
	size, ok := cockpitActionPageSize(w, r)
	if !ok {
		return
	}
	if kind == "nodes" {
		out, err := h.IssueService.ListCockpitIssueNodeReferences(r.Context(), p.WorkspaceID, issue.ID, r.URL.Query().Get("cursor"), size)
		if !writeCockpitSurfaceError(w, r, err) {
			writeJSON(w, http.StatusOK, out)
		}
	} else {
		out, err := h.IssueService.ListCockpitIssueMeetingReferences(r.Context(), p.WorkspaceID, issue.ID, r.URL.Query().Get("cursor"), size)
		if !writeCockpitSurfaceError(w, r, err) {
			writeJSON(w, http.StatusOK, out)
		}
	}
}

func (h *Handler) RemoveCockpitIssueNodeReference(w http.ResponseWriter, r *http.Request) {
	h.removeCockpitIssueReference(w, r, "node", "nodeId")
}
func (h *Handler) RemoveCockpitIssueMeetingReference(w http.ResponseWriter, r *http.Request) {
	h.removeCockpitIssueReference(w, r, "meeting", "meetingId")
}
func (h *Handler) removeCockpitIssueReference(w http.ResponseWriter, r *http.Request, kind, param string) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "issueId"))
	if !ok {
		return
	}
	target, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, param), param)
	if !ok {
		return
	}
	out, err := h.IssueService.RemoveCockpitIssueReference(r.Context(), p.WorkspaceID, issue.ID, target, p.ActorID, kind)
	if !writeCockpitSurfaceError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
