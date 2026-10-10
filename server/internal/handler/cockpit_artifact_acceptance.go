package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/service"
)

func (h *Handler) cockpitAcceptanceRead(w http.ResponseWriter, r *http.Request, human bool) (service.CockpitAcceptanceRead, bool) {
	p, ok := h.cockpitArtifactRead(w, r, human)
	input := service.CockpitAcceptanceRead{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID, Human: p.Human, Cursor: p.Cursor, PageSize: p.PageSize}
	if !ok {
		return input, false
	}
	input.NodeID, ok = parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "node_id")
	if !ok {
		return input, false
	}
	if value := chi.URLParam(r, "requestId"); value != "" {
		input.RequestID, ok = parseUUIDOrBadRequest(w, value, "request_id")
	}
	return input, ok
}
func (h *Handler) GetCockpitAcceptance(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitAcceptanceRead(w, r, false)
	if !ok {
		return
	}
	out, err := h.IssueService.GetCockpitAcceptance(r.Context(), p)
	if !writeCockpitArtifactError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) GetCockpitAcceptanceCriteria(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitAcceptanceRead(w, r, false)
	if !ok {
		return
	}
	out, err := h.IssueService.GetCockpitAcceptanceCriteria(r.Context(), p)
	if !writeCockpitArtifactError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) SaveCockpitAcceptanceCriteria(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitAcceptanceRead(w, r, true)
	if !ok {
		return
	}
	var req struct {
		cockpitWorkflowRevisionRequest
		Criteria *[]service.CockpitAcceptanceCriterionInput `json:"criteria"`
	}
	if !decodeCockpitArtifactBody(w, r, &req) {
		return
	}
	if req.ExpectedRevision == nil || *req.ExpectedRevision < 0 || req.Criteria == nil {
		writeError(w, http.StatusBadRequest, "expected_revision and criteria are required")
		return
	}
	for _, criterion := range *req.Criteria {
		if _, ok := parseUUIDOrBadRequest(w, criterion.ID, "criterion id"); !ok {
			return
		}
	}
	out, err := h.IssueService.SaveCockpitAcceptanceCriteria(r.Context(), service.CockpitAcceptanceCriteriaCommand{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID, NodeID: p.NodeID, Human: p.Human, ExpectedRevision: *req.ExpectedRevision, Criteria: *req.Criteria})
	if !writeCockpitArtifactError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) ListCockpitAcceptanceRequests(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitAcceptanceRead(w, r, false)
	if !ok {
		return
	}
	out, err := h.IssueService.ListCockpitAcceptanceRequests(r.Context(), p)
	if !writeCockpitArtifactError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) GetCockpitAcceptanceRequest(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitAcceptanceRead(w, r, false)
	if ok {
		h.writeCockpitAcceptanceRequest(w, r, p)
	}
}
func (h *Handler) writeCockpitAcceptanceRequest(w http.ResponseWriter, r *http.Request, p service.CockpitAcceptanceRead) {
	out, err := h.IssueService.GetCockpitAcceptanceRequest(r.Context(), p)
	if !writeCockpitArtifactError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) CreateCockpitAcceptanceRequest(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitAcceptanceRead(w, r, true)
	if !ok {
		return
	}
	var req struct {
		RequestKey               string                                   `json:"request_key"`
		ExpectedCriteriaRevision *int64                                   `json:"expected_criteria_revision"`
		ReviewerID               string                                   `json:"reviewer_id"`
		SupersedesRequestID      *string                                  `json:"supersedes_request_id"`
		Evidence                 []service.CockpitAcceptanceEvidenceInput `json:"evidence"`
		Note                     string                                   `json:"note"`
	}
	if !decodeCockpitArtifactBody(w, r, &req) {
		return
	}
	if req.ExpectedCriteriaRevision == nil || *req.ExpectedCriteriaRevision < 1 {
		writeError(w, http.StatusBadRequest, "expected_criteria_revision must be positive")
		return
	}
	input := service.CockpitAcceptanceRequestCommand{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID, NodeID: p.NodeID, Human: p.Human, ExpectedCriteriaRevision: *req.ExpectedCriteriaRevision, Evidence: req.Evidence, Note: req.Note}
	input.RequestKey, ok = parseUUIDOrBadRequest(w, req.RequestKey, "request_key")
	if !ok {
		return
	}
	input.ReviewerID, ok = parseUUIDOrBadRequest(w, req.ReviewerID, "reviewer_id")
	if !ok {
		return
	}
	if req.SupersedesRequestID != nil {
		input.SupersedesRequestID, ok = parseUUIDOrBadRequest(w, *req.SupersedesRequestID, "supersedes_request_id")
		if !ok {
			return
		}
	}
	for _, evidence := range req.Evidence {
		if _, ok := parseUUIDOrBadRequest(w, evidence.CriterionID, "criterion_id"); !ok {
			return
		}
		for _, id := range evidence.VersionIDs {
			if _, ok := parseUUIDOrBadRequest(w, id, "version_id"); !ok {
				return
			}
		}
	}
	out, err := h.IssueService.CreateCockpitAcceptanceRequest(r.Context(), input, service.IssueCreateOpts{ActorID: uuidToString(p.ActorID)})
	if !writeCockpitArtifactError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) ReviewCockpitAcceptanceRequest(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitAcceptanceRead(w, r, true)
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
	if req.ExpectedRevision == nil || *req.ExpectedRevision < 1 {
		writeError(w, http.StatusBadRequest, "expected_revision must be positive")
		return
	}
	err := h.IssueService.ReviewCockpitAcceptanceRequest(r.Context(), service.CockpitAcceptanceReview{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID, NodeID: p.NodeID, RequestID: p.RequestID, Human: p.Human, ExpectedRevision: *req.ExpectedRevision, Decision: req.Decision, Feedback: req.Feedback})
	if !writeCockpitArtifactError(w, r, err) {
		h.writeCockpitAcceptanceRequest(w, r, p)
	}
}
func (h *Handler) ReassignCockpitAcceptanceReviewer(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitAcceptanceRead(w, r, true)
	if !ok {
		return
	}
	var req cockpitArtifactReviewerRequest
	if !decodeCockpitArtifactBody(w, r, &req) {
		return
	}
	if req.ExpectedRevision == nil || *req.ExpectedRevision < 1 {
		writeError(w, http.StatusBadRequest, "expected_revision must be positive")
		return
	}
	input := service.CockpitAcceptanceReviewerCommand{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID, NodeID: p.NodeID, RequestID: p.RequestID, Human: p.Human, ExpectedRevision: *req.ExpectedRevision, Reason: req.Reason}
	input.HandoffKey, ok = parseUUIDOrBadRequest(w, req.HandoffKey, "handoff_key")
	if !ok {
		return
	}
	input.ReviewerID, ok = parseUUIDOrBadRequest(w, req.ReviewerID, "reviewer_id")
	if !ok {
		return
	}
	out, err := h.IssueService.ReassignCockpitAcceptanceReviewer(r.Context(), input, service.IssueCreateOpts{ActorID: uuidToString(p.ActorID)})
	if !writeCockpitArtifactError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) ListCockpitAcceptanceReviewerHandoffs(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitAcceptanceRead(w, r, false)
	if !ok {
		return
	}
	out, err := h.IssueService.ListCockpitAcceptanceReviewerHandoffs(r.Context(), p)
	if !writeCockpitArtifactError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
