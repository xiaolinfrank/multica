package handler

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type cockpitHistoryCursor struct {
	Scope     string `json:"scope"`
	ID        string `json:"id"`
	Number    int64  `json:"number"`
	CreatedAt string `json:"created_at"`
}

func historyCursorScope(x *cockpitHistoryRead, kind string, size int32, version pgtype.UUID, status string) string {
	b, _ := json.Marshal([]any{uuidToString(x.cc.workspaceID), uuidToString(x.meetingID), uuidToString(x.cc.member.UserID), x.human, kind, size, uuidToPtr(version), status})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
func decodeHistoryCursor(raw, scope string) (cockpitHistoryCursor, error) {
	if raw == "" {
		return cockpitHistoryCursor{}, nil
	}
	var c cockpitHistoryCursor
	if len(raw) > 4096 {
		return c, service.ErrCockpitWorkflowInput
	}
	b, e := base64.RawURLEncoding.DecodeString(raw)
	if e != nil || json.Unmarshal(b, &c) != nil || c.Scope != scope {
		return c, fmt.Errorf("%w: cursor does not match this meeting, filter or page size", service.ErrCockpitWorkflowInput)
	}
	if _, e = util.ParseUUID(c.ID); e != nil {
		return c, service.ErrCockpitWorkflowInput
	}
	return c, nil
}
func encodeHistoryCursor(scope string, id pgtype.UUID, number int64, stamp pgtype.Timestamptz) *string {
	c := cockpitHistoryCursor{Scope: scope, ID: uuidToString(id), Number: number}
	if stamp.Valid {
		c.CreatedAt = stamp.Time.UTC().Format(time.RFC3339Nano)
	}
	b, _ := json.Marshal(c)
	value := base64.RawURLEncoding.EncodeToString(b)
	return &value
}
func (h *Handler) GetCockpitWorkflowSummary(w http.ResponseWriter, r *http.Request) {
	x, ok := h.cockpitHistoryContext(w, r)
	if !ok {
		return
	}
	defer x.tx.Rollback(x.ctx)
	out, err := h.cockpitHistorySummary(r, x)
	if !writeCockpitActionError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) ListCockpitMinutesVersionHistory(w http.ResponseWriter, r *http.Request) {
	size, ok := cockpitActionPageSize(w, r)
	if !ok {
		return
	}
	x, ok := h.cockpitHistoryContext(w, r)
	if !ok {
		return
	}
	defer x.tx.Rollback(x.ctx)
	scope := historyCursorScope(x, "versions", size, pgtype.UUID{}, "")
	c, err := decodeHistoryCursor(r.URL.Query().Get("cursor"), scope)
	if writeCockpitActionError(w, r, err) {
		return
	}
	out := CockpitMinutesVersionPage{CockpitWorkflowHistoryScope: x.scope(), Items: []CockpitMinutesVersionMetadata{}}
	if x.work == nil {
		writeJSON(w, http.StatusOK, out)
		return
	}
	var number pgtype.Int4
	if c.ID != "" {
		if c.Number < 1 || c.Number > 2147483647 {
			writeError(w, http.StatusBadRequest, "invalid version cursor")
			return
		}
		number = pgtype.Int4{Int32: int32(c.Number), Valid: true}
	}
	rows, err := x.q.PageCockpitVersionIDs(x.ctx, db.PageCockpitVersionIDsParams{WorkspaceID: x.cc.workspaceID, MeetingID: x.meetingID, CursorNumber: number, PageLimit: size + 1})
	if writeCockpitActionError(w, r, err) {
		return
	}
	count, err := x.q.CountCockpitVersionHistory(x.ctx, db.CountCockpitVersionHistoryParams{WorkspaceID: x.cc.workspaceID, MeetingID: x.meetingID})
	if writeCockpitActionError(w, r, err) {
		return
	}
	out.Total = count
	if len(rows) > int(size) {
		rows = rows[:size]
		last := rows[len(rows)-1]
		out.NextCursor = encodeHistoryCursor(scope, last.ID, int64(last.VersionNumber), pgtype.Timestamptz{})
	}
	ids := make([]pgtype.UUID, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	meta, err := x.metadata(ids)
	if writeCockpitActionError(w, r, err) {
		return
	}
	for _, row := range rows {
		out.Items = append(out.Items, meta[row.ID])
	}
	writeJSON(w, http.StatusOK, out)
}
func (h *Handler) GetCockpitMinutesVersionDetail(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "versionId"), "version id")
	if !ok {
		return
	}
	x, ok := h.cockpitHistoryContext(w, r)
	if !ok {
		return
	}
	defer x.tx.Rollback(x.ctx)
	if x.work == nil {
		writeError(w, http.StatusNotFound, "workflow not found")
		return
	}
	version, err := x.fullVersion(id)
	if writeCockpitActionError(w, r, err) {
		return
	}
	out := CockpitMinutesVersionDetail{CockpitWorkflowHistoryScope: x.scope(), Version: version}
	own := version.ReviewerID == uuidToString(x.cc.member.UserID)
	out.CanReview = x.human && x.work.CurrentVersionID == id && version.Decision == "pending" && own
	out.CanPublish = x.human && x.work.CurrentVersionID == id && version.Decision == "approved" && (own || x.manager())
	out.CanExportNAS = x.human && version.Decision == "approved" && version.PublishedAt != nil && (own || x.manager())
	writeJSON(w, http.StatusOK, out)
}
func (h *Handler) ListCockpitReviewerHandoffHistory(w http.ResponseWriter, r *http.Request) {
	size, ok := cockpitActionPageSize(w, r)
	if !ok {
		return
	}
	x, ok := h.cockpitHistoryContext(w, r)
	if !ok {
		return
	}
	defer x.tx.Rollback(x.ctx)
	scope := historyCursorScope(x, "handoffs", size, pgtype.UUID{}, "")
	c, err := decodeHistoryCursor(r.URL.Query().Get("cursor"), scope)
	if writeCockpitActionError(w, r, err) {
		return
	}
	out := CockpitReviewerHandoffPage{CockpitWorkflowHistoryScope: x.scope(), Items: []CockpitHandoffHistoryItem{}}
	if x.work == nil {
		writeJSON(w, http.StatusOK, out)
		return
	}
	var id pgtype.UUID
	if c.ID != "" {
		id, _ = util.ParseUUID(c.ID)
		if c.Number < 1 {
			writeError(w, http.StatusBadRequest, "invalid handoff cursor")
			return
		}
	}
	rows, err := x.q.PageCockpitHandoffIDs(x.ctx, db.PageCockpitHandoffIDsParams{WorkspaceID: x.cc.workspaceID, MeetingID: x.meetingID, CursorID: id, CursorRevision: c.Number, PageLimit: size + 1})
	if writeCockpitActionError(w, r, err) {
		return
	}
	count, err := x.q.CountCockpitHandoffHistory(x.ctx, db.CountCockpitHandoffHistoryParams{WorkspaceID: x.cc.workspaceID, MeetingID: x.meetingID})
	if writeCockpitActionError(w, r, err) {
		return
	}
	out.Total = count
	if len(rows) > int(size) {
		rows = rows[:size]
		last := rows[len(rows)-1]
		out.NextCursor = encodeHistoryCursor(scope, last.ID, last.Revision, pgtype.Timestamptz{})
	}
	ids := make([]pgtype.UUID, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	items, err := x.handoffs(ids)
	if writeCockpitActionError(w, r, err) {
		return
	}
	for _, row := range rows {
		out.Items = append(out.Items, items[row.ID])
	}
	writeJSON(w, http.StatusOK, out)
}
func (h *Handler) ListCockpitNASExportHistory(w http.ResponseWriter, r *http.Request) {
	size, ok := cockpitActionPageSize(w, r)
	if !ok {
		return
	}
	var version pgtype.UUID
	if raw := r.URL.Query().Get("version_id"); raw != "" {
		version, ok = parseUUIDOrBadRequest(w, raw, "version_id")
		if !ok {
			return
		}
	}
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	switch status {
	case "", "active", "queued", "running", "retry_wait", "succeeded", "needs_attention":
	default:
		writeError(w, http.StatusBadRequest, "invalid export status")
		return
	}
	x, ok := h.cockpitHistoryContext(w, r)
	if !ok {
		return
	}
	defer x.tx.Rollback(x.ctx)
	scope := historyCursorScope(x, "exports", size, version, status)
	c, err := decodeHistoryCursor(r.URL.Query().Get("cursor"), scope)
	if writeCockpitActionError(w, r, err) {
		return
	}
	out := CockpitNASExportPage{CockpitWorkflowHistoryScope: x.scope(), VersionID: uuidToPtr(version), Status: status, Items: []CockpitNASHistoryItem{}}
	if version.Valid {
		meta, e := x.metadata([]pgtype.UUID{version})
		if e == nil {
			if _, found := meta[version]; !found {
				e = service.ErrCockpitWorkflowNotFound
			}
		}
		if writeCockpitActionError(w, r, e) {
			return
		}
	}
	if x.work == nil {
		writeJSON(w, http.StatusOK, out)
		return
	}
	var id pgtype.UUID
	var created pgtype.Timestamptz
	if c.ID != "" {
		id, _ = util.ParseUUID(c.ID)
		stamp, e := time.Parse(time.RFC3339Nano, c.CreatedAt)
		if e != nil {
			writeError(w, http.StatusBadRequest, "invalid export cursor")
			return
		}
		created = pgtype.Timestamptz{Time: stamp, Valid: true}
	}
	rows, err := x.q.PageCockpitExportIDs(x.ctx, db.PageCockpitExportIDsParams{WorkspaceID: x.cc.workspaceID, MeetingID: x.meetingID, VersionID: version, Status: status, CursorID: id, CursorCreatedAt: created, PageLimit: size + 1})
	if writeCockpitActionError(w, r, err) {
		return
	}
	out.Total, err = x.q.CountCockpitExportHistory(x.ctx, db.CountCockpitExportHistoryParams{WorkspaceID: x.cc.workspaceID, MeetingID: x.meetingID, VersionID: version, Status: status})
	if writeCockpitActionError(w, r, err) {
		return
	}
	if len(rows) > int(size) {
		rows = rows[:size]
		last := rows[len(rows)-1]
		out.NextCursor = encodeHistoryCursor(scope, last.ID, 0, last.CreatedAt)
	}
	ids := make([]pgtype.UUID, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	items, err := x.exports(ids)
	if writeCockpitActionError(w, r, err) {
		return
	}
	for _, row := range rows {
		out.Items = append(out.Items, items[row.ID])
	}
	writeJSON(w, http.StatusOK, out)
}
