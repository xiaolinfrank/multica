package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
)

type cockpitPreparationFeature uint8

const (
	cockpitTemplatesFeature cockpitPreparationFeature = iota
	cockpitDispositionFeature
	cockpitSharedPreparationFeature
)

func (h *Handler) cockpitPreparationReady(w http.ResponseWriter, feature cockpitPreparationFeature) bool {
	templates, disposition := false, false
	if h.IssueService != nil {
		templates = h.IssueService.CockpitMeetingTemplatesBackendReady
		disposition = h.IssueService.CockpitMeetingDispositionBackendReady
	}
	ready, code := templates, "meeting_templates_unavailable"
	if feature == cockpitDispositionFeature {
		ready, code = disposition, "meeting_disposition_unavailable"
	}
	if feature == cockpitSharedPreparationFeature {
		ready, code = templates && disposition, "meeting_preparation_unavailable"
	}
	if !ready {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": code, "error": "meeting preparation services are not available"})
	}
	return ready
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

func (h *Handler) cockpitTemplateQuery(w http.ResponseWriter, r *http.Request, write, requiredTemplate bool) (service.CockpitMeetingTemplateQuery, bool) {
	var p service.CockpitMeetingTemplateQuery
	if !h.cockpitPreparationReady(w, cockpitTemplatesFeature) {
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
	p.WorkspaceID, p.ActorID, p.Human = id, member.UserID, !isMachineCredentialActor(r)
	if write && !p.Human {
		writeError(w, http.StatusForbidden, "a human member must confirm this template command")
		return p, false
	}
	raw := chi.URLParam(r, "templateId")
	if raw != "" || requiredTemplate {
		p.TemplateID, ok = parseUUIDOrBadRequest(w, raw, "template id")
		if !ok {
			return p, false
		}
	}
	return p, true
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
	var exists *service.CockpitPreparationExistsError
	if errors.As(err, &exists) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error(), "code": "application_exists", "workspace_id": exists.WorkspaceID, "meeting_id": exists.MeetingID, "template_version_id": exists.TemplateVersionID, "operation_id": exists.OperationID, "command_key": exists.CommandKey})
		return true
	}
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
func templateBindingUUIDs(w http.ResponseWriter, in service.CockpitTemplateApplicationPreviewInput) bool {
	if _, ok := parseUUIDOrBadRequest(w, in.TemplateVersionID, "template_version_id"); !ok {
		return false
	}
	for _, b := range in.Bindings {
		if _, ok := parseUUIDOrBadRequest(w, b.SlotID, "slot_id"); !ok {
			return false
		}
		for field, value := range map[string]*string{"node_id": b.NodeID, "facilitator_user_id": b.FacilitatorUserID, "project_id": b.ProjectID, "module_id": b.ModuleID, "assignee_id": b.AssigneeID, "issue_id": b.IssueID, "material_reference_id": b.MaterialReferenceID} {
			if !lifecycleOptionalUUID(w, value, field) {
				return false
			}
		}
	}
	return true
}
func cancellationChoiceUUIDs(w http.ResponseWriter, in service.CockpitCancellationPreviewInput) bool {
	for _, choice := range in.Issues {
		if _, ok := parseUUIDOrBadRequest(w, choice.IssueID, "issue_id"); !ok {
			return false
		}
		for field, value := range map[string]*string{"target_meeting_id": choice.TargetMeetingID, "target_agenda_id": choice.TargetAgendaID} {
			if !lifecycleOptionalUUID(w, value, field) {
				return false
			}
		}
	}
	for _, id := range in.RunIDs {
		if _, ok := parseUUIDOrBadRequest(w, id, "run_id"); !ok {
			return false
		}
	}
	return true
}

func (h *Handler) ListCockpitMeetingTemplates(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitTemplateQuery(w, r, false, false)
	if !ok || !cockpitPreparationQueryKeys(w, r, "q", "include_inactive", "cursor", "page_size") {
		return
	}
	p.PageSize, ok = cockpitActionPageSize(w, r)
	if !ok {
		return
	}
	p.Query, p.Cursor = r.URL.Query().Get("q"), r.URL.Query().Get("cursor")
	if raw := r.URL.Query().Get("include_inactive"); raw != "" {
		var err error
		p.IncludeInactive, err = strconv.ParseBool(raw)
		if err != nil {
			writeError(w, 400, "include_inactive must be boolean")
			return
		}
	}
	out, err := h.IssueService.ListCockpitMeetingTemplates(r.Context(), p)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) GetCockpitMeetingTemplate(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitTemplateQuery(w, r, false, true)
	if !ok || !cockpitPreparationQueryKeys(w, r) {
		return
	}
	out, err := h.IssueService.GetCockpitMeetingTemplate(r.Context(), p)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) ListCockpitMeetingTemplateVersions(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitTemplateQuery(w, r, false, true)
	if !ok || !cockpitPreparationQueryKeys(w, r, "cursor", "page_size") {
		return
	}
	p.PageSize, ok = cockpitActionPageSize(w, r)
	if !ok {
		return
	}
	p.Cursor = r.URL.Query().Get("cursor")
	out, err := h.IssueService.ListCockpitMeetingTemplateVersions(r.Context(), p)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) GetCockpitMeetingTemplateVersion(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitTemplateQuery(w, r, false, true)
	if !ok || !cockpitPreparationQueryKeys(w, r) {
		return
	}
	p.VersionID, ok = parseUUIDOrBadRequest(w, chi.URLParam(r, "versionId"), "version id")
	if !ok {
		return
	}
	out, err := h.IssueService.GetCockpitMeetingTemplateVersion(r.Context(), p)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) GetCockpitMeetingTemplateCommand(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitTemplateQuery(w, r, false, false)
	if !ok || !cockpitPreparationQueryKeys(w, r) {
		return
	}
	key, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "commandKey"), "command_key")
	if !ok {
		return
	}
	out, err := h.IssueService.GetCockpitMeetingTemplateCommand(r.Context(), p, key)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) SaveCockpitMeetingTemplate(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitTemplateQuery(w, r, true, false)
	if !ok || !cockpitPreparationQueryKeys(w, r) {
		return
	}
	var body struct {
		CommandKey       string                                `json:"command_key"`
		ExpectedRevision *int64                                `json:"expected_revision"`
		Title            *string                               `json:"title"`
		Description      *string                               `json:"description"`
		Active           *bool                                 `json:"active"`
		Config           *service.CockpitMeetingTemplateConfig `json:"config"`
	}
	if !decodeCockpitLifecycleBody(w, r, &body) {
		return
	}
	if body.ExpectedRevision == nil || body.Title == nil || body.Description == nil || body.Active == nil || body.Config == nil {
		writeError(w, http.StatusBadRequest, "saving a template requires every configuration field")
		return
	}
	in := service.CockpitMeetingTemplateSaveInput{CommandKey: body.CommandKey, ExpectedRevision: *body.ExpectedRevision,
		Title: *body.Title, Description: *body.Description, Active: *body.Active, Config: *body.Config}
	if _, ok = parseUUIDOrBadRequest(w, in.CommandKey, "command_key"); !ok {
		return
	}
	if in.ExpectedRevision < 0 || p.TemplateID.Valid && in.ExpectedRevision < 1 || !p.TemplateID.Valid && in.ExpectedRevision != 0 {
		writeError(w, 400, "expected_revision does not match template creation or version update")
		return
	}
	for _, slot := range in.Config.Slots {
		if _, ok = parseUUIDOrBadRequest(w, slot.SlotID, "slot_id"); !ok {
			return
		}
		if !lifecycleOptionalUUID(w, slot.AgendaSlotID, "agenda_slot_id") {
			return
		}
	}
	out, err := h.IssueService.SaveCockpitMeetingTemplate(r.Context(), p, in)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) PreviewCockpitTemplateApplication(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationContext(w, r, false, cockpitTemplatesFeature)
	if !ok || !cockpitPreparationQueryKeys(w, r) {
		return
	}
	var in service.CockpitTemplateApplicationPreviewInput
	if !decodeCockpitLifecycleBody(w, r, &in) || !templateBindingUUIDs(w, in) {
		return
	}
	out, err := h.IssueService.PreviewCockpitTemplateApplication(r.Context(), p, in)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) CreateCockpitTemplateApplication(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationContext(w, r, true, cockpitTemplatesFeature)
	if !ok || !cockpitPreparationQueryKeys(w, r) {
		return
	}
	var in service.CockpitTemplateApplicationInput
	if !decodeCockpitLifecycleBody(w, r, &in) || !lifecycleCommandID(w, in.CockpitLifecycleCommandInput) || !templateBindingUUIDs(w, in.CockpitTemplateApplicationPreviewInput) {
		return
	}
	out, err := h.IssueService.CreateCockpitTemplateApplication(r.Context(), p, in)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) ListCockpitPreparationOperations(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationQuery(w, r, false, cockpitSharedPreparationFeature)
	if !ok || !cockpitPreparationPage(w, r, &p, false) {
		return
	}
	out, err := h.IssueService.ListCockpitPreparationOperations(r.Context(), p)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) GetCockpitPreparationOperation(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationQuery(w, r, false, cockpitSharedPreparationFeature, "operationId")
	if !ok || !cockpitPreparationQueryKeys(w, r) {
		return
	}
	out, err := h.IssueService.GetCockpitPreparationOperation(r.Context(), p)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) ListCockpitPreparationEffects(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationQuery(w, r, false, cockpitSharedPreparationFeature, "operationId")
	if !ok || !cockpitPreparationPage(w, r, &p, false) {
		return
	}
	out, err := h.IssueService.ListCockpitPreparationEffects(r.Context(), p)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) GetCockpitPreparationEffect(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationQuery(w, r, false, cockpitSharedPreparationFeature, "operationId", "effectId")
	if !ok || !cockpitPreparationQueryKeys(w, r) {
		return
	}
	out, err := h.IssueService.GetCockpitPreparationEffect(r.Context(), p)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) ApplyCockpitPreparationEffect(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationQuery(w, r, true, cockpitSharedPreparationFeature, "operationId", "effectId")
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
	p, ok := h.cockpitPreparationQuery(w, r, true, cockpitSharedPreparationFeature, "operationId")
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

func (h *Handler) PreviewCockpitPreparationReauthorization(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationQuery(w, r, false, cockpitSharedPreparationFeature, "operationId", "effectId")
	if !ok || !cockpitPreparationQueryKeys(w, r) {
		return
	}
	out, err := h.IssueService.PreviewCockpitPreparationReauthorization(r.Context(), p)
	cockpitPreparationJSON(w, r, out, err)
}
func (h *Handler) ReauthorizeCockpitPreparationEffect(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitPreparationQuery(w, r, true, cockpitSharedPreparationFeature, "operationId", "effectId")
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
