package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
)

type cockpitPreparationFeature uint8

const (
	cockpitDispositionFeature cockpitPreparationFeature = iota
)

func (h *Handler) cockpitPreparationReady(w http.ResponseWriter, feature cockpitPreparationFeature) bool {
	disposition := h.IssueService != nil && h.IssueService.CockpitMeetingDispositionBackendReady
	if !disposition {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "meeting_disposition_unavailable", "error": "meeting preparation services are not available"})
	}
	return disposition
}

func cockpitPreparationQueryKeys(w http.ResponseWriter, r *http.Request, keys ...string) bool {
	allowed := map[string]bool{}
	for _, key := range keys {
		allowed[key] = true
	}
	for key, values := range r.URL.Query() {
		if !allowed[key] || len(values) != 1 {
			writeError(w, http.StatusBadRequest, "unsupported or repeated meeting preparation query parameter")
			return false
		}
	}
	return true
}

func (h *Handler) cockpitPreparationContext(w http.ResponseWriter, r *http.Request, write bool, feature cockpitPreparationFeature) (service.CockpitLifecycleRead, bool) {
	if !h.cockpitPreparationReady(w, feature) {
		return service.CockpitLifecycleRead{}, false
	}
	return h.cockpitLifecycleRead(w, r, write)
}
func (h *Handler) cockpitPreparationQuery(w http.ResponseWriter, r *http.Request, write bool, feature cockpitPreparationFeature, required ...string) (service.CockpitPreparationQuery, bool) {
	context, ok := h.cockpitPreparationContext(w, r, write, feature)
	p := service.CockpitPreparationQuery{CockpitLifecycleRead: context}
	if !ok {
		return p, false
	}
	for _, item := range []struct {
		name  string
		value *pgtype.UUID
	}{{"operationId", &p.OperationID}, {"effectId", &p.EffectID}, {"issueId", &p.IssueID}} {
		raw := chi.URLParam(r, item.name)
		must := false
		for _, name := range required {
			if name == item.name {
				must = true
			}
		}
		if raw != "" || must {
			*item.value, ok = parseUUIDOrBadRequest(w, raw, item.name)
			if !ok {
				return p, false
			}
		}
	}
	return p, true
}
func cockpitPreparationPage(w http.ResponseWriter, r *http.Request, p *service.CockpitPreparationQuery, search bool) bool {
	keys := []string{"cursor", "page_size"}
	if search {
		keys = append(keys, "q")
	}
	if !cockpitPreparationQueryKeys(w, r, keys...) {
		return false
	}
	size, ok := cockpitActionPageSize(w, r)
	if !ok {
		return false
	}
	p.PageSize, p.Cursor, p.Query = size, r.URL.Query().Get("cursor"), r.URL.Query().Get("q")
	return true
}
func writeCockpitPreparationError(w http.ResponseWriter, r *http.Request, err error) bool {
	if errors.Is(err, service.ErrCockpitPreparationContextChanged) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error(), "code": "context_changed"})
		return true
	}
	return writeCockpitLifecycleError(w, r, err)
}
func cockpitPreparationJSON(w http.ResponseWriter, r *http.Request, out any, err error) {
	if !writeCockpitPreparationError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func cancellationChoiceUUIDs(w http.ResponseWriter, in service.CockpitCancellationPreviewInput) bool {
	for _, choice := range in.Issues {
		if _, ok := parseUUIDOrBadRequest(w, choice.IssueID, "issue_id"); !ok {
			return false
		}
		if !lifecycleOptionalUUID(w, choice.TargetMeetingID, "target_meeting_id") {
			return false
		}
	}
	for _, id := range in.RunIDs {
		if _, ok := parseUUIDOrBadRequest(w, id, "run_id"); !ok {
			return false
		}
	}
	return true
}

func (h *Handler) ListCockpitPreparationOperations(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationQuery(w, r, false, cockpitDispositionFeature)
	if !ok || !cockpitPreparationPage(w, r, &p, false) {
		return
	}
	out, err := h.IssueService.ListCockpitPreparationOperations(r.Context(), p)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) GetCockpitPreparationOperation(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationQuery(w, r, false, cockpitDispositionFeature, "operationId")
	if !ok || !cockpitPreparationQueryKeys(w, r) {
		return
	}
	out, err := h.IssueService.GetCockpitPreparationOperation(r.Context(), p)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) ListCockpitPreparationEffects(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationQuery(w, r, false, cockpitDispositionFeature, "operationId")
	if !ok || !cockpitPreparationPage(w, r, &p, false) {
		return
	}
	out, err := h.IssueService.ListCockpitPreparationEffects(r.Context(), p)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) GetCockpitPreparationEffect(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationQuery(w, r, false, cockpitDispositionFeature, "operationId", "effectId")
	if !ok || !cockpitPreparationQueryKeys(w, r) {
		return
	}
	out, err := h.IssueService.GetCockpitPreparationEffect(r.Context(), p)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) ApplyCockpitPreparationEffect(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationQuery(w, r, true, cockpitDispositionFeature, "operationId", "effectId")
	if !ok || !cockpitPreparationQueryKeys(w, r) {
		return
	}
	var in service.CockpitPreparationEffectApplyInput
	if !decodeCockpitLifecycleBody(w, r, &in) {
		return
	}
	if _, ok = parseUUIDOrBadRequest(w, in.CommandKey, "command_key"); !ok {
		return
	}
	if _, ok = parseUUIDOrBadRequest(w, in.AuthorizationKey, "authorization_key"); !ok {
		return
	}
	if in.AuthorizationRevision < 1 {
		writeError(w, http.StatusBadRequest, "authorization_revision must be positive")
		return
	}
	out, err := h.IssueService.ApplyCockpitPreparationEffect(r.Context(), p, in, service.IssueCreateOpts{ActorID: uuidToString(p.ActorID)})
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) ControlCockpitPreparationOperation(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationQuery(w, r, true, cockpitDispositionFeature, "operationId")
	if !ok || !cockpitPreparationQueryKeys(w, r) {
		return
	}
	var in service.CockpitPreparationControlInput
	if !decodeCockpitLifecycleBody(w, r, &in) || !lifecycleCommandID(w, in.CockpitLifecycleCommandInput) || !lifecycleOptionalUUID(w, in.EffectID, "effect_id") {
		return
	}
	out, err := h.IssueService.ControlCockpitPreparationOperation(r.Context(), p, in)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) PreviewCockpitPreparationReauthorization(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationQuery(w, r, false, cockpitDispositionFeature, "operationId", "effectId")
	if !ok || !cockpitPreparationQueryKeys(w, r) {
		return
	}
	out, err := h.IssueService.PreviewCockpitPreparationReauthorization(r.Context(), p)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) ReauthorizeCockpitPreparationEffect(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationQuery(w, r, true, cockpitDispositionFeature, "operationId", "effectId")
	if !ok || !cockpitPreparationQueryKeys(w, r) {
		return
	}
	var in service.CockpitPreparationReauthorizationInput
	if !decodeCockpitLifecycleBody(w, r, &in) || !lifecycleCommandID(w, in.CockpitLifecycleCommandInput) {
		return
	}
	out, err := h.IssueService.ReauthorizeCockpitPreparationEffect(r.Context(), p, in)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) ListCockpitCancellationImpact(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationQuery(w, r, false, cockpitDispositionFeature)
	if !ok || !cockpitPreparationPage(w, r, &p, true) {
		return
	}
	out, err := h.IssueService.ListCockpitCancellationImpact(r.Context(), p)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) ListCockpitDispositionRuns(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationQuery(w, r, false, cockpitDispositionFeature, "issueId")
	if !ok || !cockpitPreparationPage(w, r, &p, false) {
		return
	}
	out, err := h.IssueService.ListCockpitDispositionRuns(r.Context(), p)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) PreviewCockpitMeetingCancellation(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationContext(w, r, false, cockpitDispositionFeature)
	if !ok || !cockpitPreparationQueryKeys(w, r) {
		return
	}
	var in service.CockpitCancellationPreviewInput
	if !decodeCockpitLifecycleBody(w, r, &in) || !cancellationChoiceUUIDs(w, in) {
		return
	}
	out, err := h.IssueService.PreviewCockpitMeetingCancellation(r.Context(), p, in)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) CancelCockpitMeeting(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationContext(w, r, true, cockpitDispositionFeature)
	if !ok || !cockpitPreparationQueryKeys(w, r) {
		return
	}
	var in service.CockpitCancellationInput
	if !decodeCockpitLifecycleBody(w, r, &in) || !lifecycleCommandID(w, in.CockpitLifecycleCommandInput) || !cancellationChoiceUUIDs(w, in.CockpitCancellationPreviewInput) {
		return
	}
	out, err := h.IssueService.CancelCockpitMeeting(r.Context(), p, in)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) ChangeCockpitMeetingDisposition(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationContext(w, r, true, cockpitDispositionFeature)
	if !ok || !cockpitPreparationQueryKeys(w, r) {
		return
	}
	var in service.CockpitMeetingDispositionInput
	if !decodeCockpitLifecycleBody(w, r, &in) || !lifecycleCommandID(w, in.CockpitLifecycleCommandInput) {
		return
	}
	out, err := h.IssueService.ChangeCockpitMeetingDisposition(r.Context(), p, in)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) GetCockpitMeetingOperationBasis(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationContext(w, r, false, cockpitDispositionFeature)
	if !ok || !cockpitPreparationQueryKeys(w, r) {
		return
	}
	out, err := h.IssueService.GetCockpitMeetingOperationBasis(r.Context(), p)
	cockpitPreparationJSON(w, r, out, err)
}

func (h *Handler) AppendCockpitMeetingDisposition(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationContext(w, r, true, cockpitDispositionFeature)
	if !ok || !cockpitPreparationQueryKeys(w, r) {
		return
	}
	var in service.CockpitCancellationInput
	if !decodeCockpitLifecycleBody(w, r, &in) || !lifecycleCommandID(w, in.CockpitLifecycleCommandInput) || !cancellationChoiceUUIDs(w, in.CockpitCancellationPreviewInput) {
		return
	}
	out, err := h.IssueService.AppendCockpitMeetingDisposition(r.Context(), p, in)
	cockpitPreparationJSON(w, r, out, err)
}
