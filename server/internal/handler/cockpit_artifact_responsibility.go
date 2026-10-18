package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/service"
)

func (h *Handler) AssignCockpitArtifactProducer(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitArtifactRead(w, r, true)
	if !ok {
		return
	}
	var req struct {
		cockpitWorkflowRevisionRequest
		CommandKey string                          `json:"command_key"`
		IssueID    *string                         `json:"issue_id"`
		NewIssue   *cockpitArtifactNewIssueRequest `json:"new_issue"`
		Reason     string                          `json:"reason"`
	}
	if !decodeCockpitArtifactBody(w, r, &req) {
		return
	}
	command, ok := cockpitArtifactCommand(w, p, req.ExpectedRevision)
	if !ok {
		return
	}
	if (req.IssueID == nil) == (req.NewIssue == nil) {
		writeError(w, http.StatusBadRequest, "choose exactly one of issue_id and new_issue")
		return
	}
	input := service.CockpitArtifactProducerCommand{CockpitArtifactCommand: command, Reason: req.Reason}
	input.CommandKey, ok = parseUUIDOrBadRequest(w, req.CommandKey, "command_key")
	if !ok {
		return
	}
	if req.IssueID != nil {
		input.IssueID, ok = parseUUIDOrBadRequest(w, *req.IssueID, "issue_id")
		if !ok {
			return
		}
	}
	input.NewIssue, ok = cockpitArtifactNewIssue(w, p, req.NewIssue)
	if !ok {
		return
	}
	out, err := h.IssueService.AssignCockpitArtifactProducer(r.Context(), input, service.IssueCreateOpts{ActorID: uuidToString(p.ActorID)})
	if !writeCockpitArtifactError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) ReassignCockpitArtifactReviewer(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitArtifactRead(w, r, true)
	if !ok {
		return
	}
	var req cockpitArtifactReviewerRequest
	if !decodeCockpitArtifactBody(w, r, &req) {
		return
	}
	command, ok := cockpitArtifactCommand(w, p, req.ExpectedRevision)
	if !ok {
		return
	}
	input := service.CockpitArtifactReviewerCommand{CockpitArtifactCommand: command, Reason: req.Reason}
	input.HandoffKey, ok = parseUUIDOrBadRequest(w, req.HandoffKey, "handoff_key")
	if !ok {
		return
	}
	input.ReviewerID, ok = parseUUIDOrBadRequest(w, req.ReviewerID, "reviewer_id")
	if !ok {
		return
	}
	out, err := h.IssueService.ReassignCockpitArtifactReviewer(r.Context(), input, service.IssueCreateOpts{ActorID: uuidToString(p.ActorID)})
	if !writeCockpitArtifactError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

type cockpitArtifactReviewerRequest struct {
	cockpitWorkflowRevisionRequest
	HandoffKey string `json:"handoff_key"`
	ReviewerID string `json:"reviewer_id"`
	Reason     string `json:"reason"`
}

func (h *Handler) ListCockpitArtifactProducerHistory(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitArtifactRead(w, r, false)
	if !ok {
		return
	}
	out, err := h.IssueService.ListCockpitArtifactProducerHistory(r.Context(), p)
	if !writeCockpitArtifactError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) ListCockpitArtifactReviewerHandoffs(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitArtifactRead(w, r, false)
	if !ok {
		return
	}
	out, err := h.IssueService.ListCockpitArtifactReviewerHandoffs(r.Context(), p)
	if !writeCockpitArtifactError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) ListCockpitArtifactSourceAttachments(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitArtifactRead(w, r, false)
	if !ok {
		return
	}
	out, err := h.IssueService.ListCockpitArtifactSourceAttachments(r.Context(), p)
	if !writeCockpitArtifactError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) RetryCockpitArtifactCapture(w http.ResponseWriter, r *http.Request) {
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
	err := h.IssueService.RetryCockpitArtifactCapture(r.Context(), service.CockpitArtifactCaptureRetry{CockpitArtifactCommand: command, VersionID: p.VersionID})
	if !writeCockpitArtifactError(w, r, err) {
		h.writeCockpitArtifactVersionCommand(w, r, p, http.StatusAccepted)
	}
}

func (h *Handler) ListCockpitArtifactNodeReferences(w http.ResponseWriter, r *http.Request) {
	h.listCockpitArtifactReferences(w, r, "node")
}
func (h *Handler) CreateCockpitArtifactNodeReference(w http.ResponseWriter, r *http.Request) {
	h.createCockpitArtifactReference(w, r, "node")
}
func (h *Handler) RemoveCockpitArtifactNodeReference(w http.ResponseWriter, r *http.Request) {
	h.removeCockpitArtifactReference(w, r, "node")
}
func (h *Handler) listCockpitArtifactReferences(w http.ResponseWriter, r *http.Request, kind string) {
	p, ok := h.cockpitArtifactRead(w, r, false)
	if !ok {
		return
	}
	out, err := h.IssueService.ListCockpitArtifactReferences(r.Context(), p, kind)
	if !writeCockpitArtifactError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) createCockpitArtifactReference(w http.ResponseWriter, r *http.Request, kind string) {
	p, ok := h.cockpitArtifactRead(w, r, true)
	if !ok {
		return
	}
	var req struct {
		ReferenceKey string  `json:"reference_key"`
		VersionID    string  `json:"version_id"`
		NodeID       *string `json:"node_id"`
		MeetingID    *string `json:"meeting_id"`
		Purpose      string  `json:"purpose"`
	}
	if !decodeCockpitArtifactBody(w, r, &req) {
		return
	}
	input := service.CockpitArtifactReferenceCommand{CockpitArtifactCommand: service.CockpitArtifactCommand{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID, ArtifactID: p.ArtifactID, Human: p.Human}, Purpose: req.Purpose}
	input.ReferenceKey, ok = parseUUIDOrBadRequest(w, req.ReferenceKey, "reference_key")
	if !ok {
		return
	}
	input.VersionID, ok = parseUUIDOrBadRequest(w, req.VersionID, "version_id")
	if !ok {
		return
	}
	if kind == "node" && req.NodeID != nil && req.MeetingID == nil {
		input.NodeID, ok = parseUUIDOrBadRequest(w, *req.NodeID, "node_id")
	} else if kind == "meeting" && req.MeetingID != nil && req.NodeID == nil {
		input.MeetingID, ok = parseUUIDOrBadRequest(w, *req.MeetingID, "meeting_id")
	} else {
		writeError(w, http.StatusBadRequest, "reference target must match the requested kind")
		return
	}
	if !ok {
		return
	}
	out, err := h.IssueService.CreateCockpitArtifactReference(r.Context(), input, kind)

	if !writeCockpitArtifactError(w, r, err) {
		p.NodeID, p.VersionID = input.NodeID, input.VersionID
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) removeCockpitArtifactReference(w http.ResponseWriter, r *http.Request, kind string) {
	p, ok := h.cockpitArtifactRead(w, r, true)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "referenceId"), "reference_id")
	if !ok {
		return
	}
	out, err := h.IssueService.RemoveCockpitArtifactReference(r.Context(), service.CockpitArtifactReferenceCommand{CockpitArtifactCommand: service.CockpitArtifactCommand{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID, ArtifactID: p.ArtifactID, Human: p.Human}, ReferenceID: id}, kind)
	if !writeCockpitArtifactError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
