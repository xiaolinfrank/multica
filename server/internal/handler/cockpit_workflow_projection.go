package handler

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type cockpitHistoryRead struct {
	ctx       context.Context
	tx        pgx.Tx
	q         *db.Queries
	cc        cockpitContext
	meetingID pgtype.UUID
	nasDir    string
	work      *db.CockpitMeetingWorkPackage
	human     bool
}

func historyError(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return service.ErrCockpitWorkflowNotFound
	}
	return err
}
func (h *Handler) beginCockpitHistory(r *http.Request, cc cockpitContext, meetingID pgtype.UUID) (*cockpitHistoryRead, error) {
	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return nil, err
	}
	read := &cockpitHistoryRead{ctx: ctx, tx: tx, q: h.Queries.WithTx(tx), cc: cc, meetingID: meetingID, human: !isMachineCredentialActor(r)}
	fail := func(err error) (*cockpitHistoryRead, error) { _ = tx.Rollback(ctx); return nil, historyError(err) }
	if _, err = tx.Exec(ctx, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"); err != nil {
		return fail(err)
	}
	member, err := read.q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{WorkspaceID: cc.workspaceID, UserID: cc.member.UserID})
	if err != nil {
		return fail(err)
	}
	read.cc.member = member
	meeting, err := read.q.GetCockpitWorkflowMeetingIdentity(ctx, db.GetCockpitWorkflowMeetingIdentityParams{WorkspaceID: cc.workspaceID, ID: meetingID})
	if err != nil {
		return fail(err)
	}
	read.nasDir = meeting.NasDir
	work, err := read.q.GetCockpitWorkflowSnapshot(ctx, db.GetCockpitWorkflowSnapshotParams{WorkspaceID: cc.workspaceID, MeetingID: meetingID})
	if err == nil {
		read.work = &work
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return fail(err)
	}
	return read, nil
}
func (h *Handler) cockpitHistoryContext(w http.ResponseWriter, r *http.Request) (*cockpitHistoryRead, bool) {
	ws := h.resolveWorkspaceID(r)
	id, ok := parseUUIDOrBadRequest(w, ws, "workspace id")
	if !ok {
		return nil, false
	}
	member, ok := h.requireWorkspaceMember(w, r, ws, "workspace not found")
	if !ok {
		return nil, false
	}
	meeting, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "meetingId"), "meeting id")
	if !ok {
		return nil, false
	}
	read, err := h.beginCockpitHistory(r, cockpitContext{workspaceID: id, member: member}, meeting)
	if writeCockpitActionError(w, r, err) {
		return nil, false
	}
	return read, true
}
func (x *cockpitHistoryRead) scope() CockpitWorkflowHistoryScope {
	var revision int64
	if x.work != nil {
		revision = x.work.Revision
	}
	return CockpitWorkflowHistoryScope{WorkspaceID: uuidToString(x.cc.workspaceID), MeetingID: uuidToString(x.meetingID), WorkflowRevision: revision}
}
func (x *cockpitHistoryRead) manager() bool {
	return x.work != nil && cockpitWorkflowManagedBy(*x.work, x.cc.member)
}
func (x *cockpitHistoryRead) cards(ids []pgtype.UUID) (map[pgtype.UUID]*CockpitWorkflowIssueResponse, error) {
	out := map[pgtype.UUID]*CockpitWorkflowIssueResponse{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := x.q.ListCockpitWorkflowIssueCards(x.ctx, db.ListCockpitWorkflowIssueCardsParams{WorkspaceID: x.cc.workspaceID, IssueIds: ids})
	if err != nil {
		return nil, err
	}
	for _, i := range rows {
		out[i.ID] = &CockpitWorkflowIssueResponse{ID: uuidToString(i.ID), Identifier: i.Identifier, Title: i.Title, Status: i.Status, AssigneeType: textToPtr(i.AssigneeType), AssigneeID: uuidToPtr(i.AssigneeID)}
	}
	return out, nil
}
func (x *cockpitHistoryRead) metadata(ids []pgtype.UUID) (map[pgtype.UUID]CockpitMinutesVersionMetadata, error) {
	out := map[pgtype.UUID]CockpitMinutesVersionMetadata{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := x.q.ListCockpitVersionMetadata(x.ctx, db.ListCockpitVersionMetadataParams{WorkspaceID: x.cc.workspaceID, MeetingID: x.meetingID, VersionIds: ids})
	if err != nil {
		return nil, err
	}
	issues := make([]pgtype.UUID, 0, len(rows))
	for _, v := range rows {
		issues = append(issues, v.ReviewIssueID)
	}
	cards, err := x.cards(issues)
	if err != nil {
		return nil, err
	}
	for _, v := range rows {
		out[v.ID] = CockpitMinutesVersionMetadata{ID: uuidToString(v.ID), VersionNumber: v.VersionNumber, SubmissionKey: uuidToString(v.SubmissionKey), ContentHash: v.ContentHash,
			SourceIssueID: uuidToString(v.SourceIssueID), ReviewIssue: cards[v.ReviewIssueID], ReviewerID: uuidToString(v.ReviewerID), Decision: v.Decision, HasFeedback: v.HasFeedback,
			SubmittedByType: v.SubmittedByType, SubmittedByID: uuidToString(v.SubmittedByID), CreatedAt: v.CreatedAt.Time.UTC().Format(time.RFC3339Nano), ReviewedBy: uuidToPtr(v.ReviewedBy), ReviewedAt: cockpitWorkflowTime(v.ReviewedAt), PublishedBy: uuidToPtr(v.PublishedBy), PublishedAt: cockpitWorkflowTime(v.PublishedAt)}
	}
	return out, nil
}
func cockpitMinutesVersionToResponse(v db.CockpitMinutesVersion, card *CockpitWorkflowIssueResponse) CockpitMinutesVersionResponse {
	return CockpitMinutesVersionResponse{ID: uuidToString(v.ID), VersionNumber: v.VersionNumber, SubmissionKey: uuidToString(v.SubmissionKey), Content: v.Content, ContentHash: v.ContentHash,
		SourceIssueID: uuidToString(v.SourceIssueID), ReviewIssue: card, ReviewerID: uuidToString(v.ReviewerID), Decision: v.Decision, Feedback: v.Feedback, SubmittedByType: v.SubmittedByType,
		SubmittedByID: uuidToString(v.SubmittedByID), CreatedAt: v.CreatedAt.Time.UTC().Format(time.RFC3339Nano), ReviewedBy: uuidToPtr(v.ReviewedBy), ReviewedAt: cockpitWorkflowTime(v.ReviewedAt), PublishedBy: uuidToPtr(v.PublishedBy), PublishedAt: cockpitWorkflowTime(v.PublishedAt)}
}
func (x *cockpitHistoryRead) fullVersion(id pgtype.UUID) (CockpitMinutesVersionResponse, error) {
	v, err := x.q.GetCockpitMinutesVersion(x.ctx, db.GetCockpitMinutesVersionParams{WorkspaceID: x.cc.workspaceID, MeetingID: x.meetingID, ID: id})
	if err != nil {
		return CockpitMinutesVersionResponse{}, historyError(err)
	}
	cards, err := x.cards([]pgtype.UUID{v.ReviewIssueID})
	if err != nil {
		return CockpitMinutesVersionResponse{}, err
	}
	return cockpitMinutesVersionToResponse(v, cards[v.ReviewIssueID]), nil
}
func (x *cockpitHistoryRead) canExport(v CockpitMinutesVersionMetadata) bool {
	return x.human && v.Decision == "approved" && v.PublishedAt != nil && (x.manager() || v.ReviewerID == uuidToString(x.cc.member.UserID))
}
func cockpitNASExportToResponse(e db.CockpitMinutesExport, mayExport bool) CockpitMinutesExportResponse {
	var size *int64
	if e.SizeBytes.Valid {
		value := e.SizeBytes.Int64
		size = &value
	}
	var next *string
	if e.Status == "retry_wait" || e.Status == "queued" {
		next = cockpitWorkflowTime(e.NextRetryAt)
	}
	return CockpitMinutesExportResponse{ID: uuidToString(e.ID), VersionID: uuidToString(e.VersionID), VersionNumber: e.VersionNumber, SourceIssueID: uuidToString(e.SourceIssueID), ContentHash: e.ContentHash, RootID: e.RootID, Directory: e.Directory, TargetPath: e.TargetPath, Status: e.Status, Attempts: e.Attempts, Revision: e.Revision, NextRetryAt: next,
		CreatedAt: e.CreatedAt.Time.UTC().Format(time.RFC3339Nano), UpdatedAt: e.UpdatedAt.Time.UTC().Format(time.RFC3339Nano), CompletedAt: cockpitWorkflowTime(e.CompletedAt), LastErrorCode: e.LastErrorCode, LastError: e.LastError, SizeBytes: size, CanRetry: mayExport && (e.Status == "retry_wait" || e.Status == "needs_attention")}
}
func (x *cockpitHistoryRead) exports(ids []pgtype.UUID) (map[pgtype.UUID]CockpitNASHistoryItem, error) {
	out := map[pgtype.UUID]CockpitNASHistoryItem{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := x.q.ListCockpitExportHistoryRows(x.ctx, db.ListCockpitExportHistoryRowsParams{WorkspaceID: x.cc.workspaceID, MeetingID: x.meetingID, ExportIds: ids})
	if err != nil {
		return nil, err
	}
	versions := make([]pgtype.UUID, 0, len(rows))
	for _, e := range rows {
		versions = append(versions, e.VersionID)
	}
	meta, err := x.metadata(versions)
	if err != nil {
		return nil, err
	}
	for _, e := range rows {
		v, ok := meta[e.VersionID]
		if !ok {
			return nil, service.ErrCockpitWorkflowNotFound
		}
		out[e.ID] = CockpitNASHistoryItem{CockpitMinutesExportResponse: cockpitNASExportToResponse(e, x.canExport(v)), SourceVersion: v}
	}
	return out, nil
}
func (x *cockpitHistoryRead) handoffs(ids []pgtype.UUID) (map[pgtype.UUID]CockpitHandoffHistoryItem, error) {
	out := map[pgtype.UUID]CockpitHandoffHistoryItem{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := x.q.ListCockpitHandoffHistoryRows(x.ctx, db.ListCockpitHandoffHistoryRowsParams{WorkspaceID: x.cc.workspaceID, MeetingID: x.meetingID, HandoffIds: ids})
	if err != nil {
		return nil, err
	}
	issueIDs, userIDs := []pgtype.UUID{}, []pgtype.UUID{}
	for _, row := range rows {
		h := row.CockpitReviewerHandoff
		issueIDs = append(issueIDs, h.FromReviewIssueID, h.ToReviewIssueID)
		userIDs = append(userIDs, h.FromReviewerID, h.ToReviewerID, h.CreatedBy)
	}
	cards, err := x.cards(issueIDs)
	if err != nil {
		return nil, err
	}
	users, err := x.q.ListCockpitHistoryNames(x.ctx, userIDs)
	if err != nil {
		return nil, err
	}
	names := map[pgtype.UUID]string{}
	for _, u := range users {
		names[u.ID] = u.Name
	}
	for _, row := range rows {
		h := row.CockpitReviewerHandoff
		var number *int32
		if row.VersionNumber.Valid {
			value := row.VersionNumber.Int32
			number = &value
		}
		out[h.ID] = CockpitHandoffHistoryItem{VersionNumber: number, CockpitReviewerHandoffResponse: CockpitReviewerHandoffResponse{ID: uuidToString(h.ID), HandoffKey: uuidToString(h.HandoffKey), FromReviewerID: uuidToString(h.FromReviewerID), ToReviewerID: uuidToString(h.ToReviewerID), FromReviewerName: names[h.FromReviewerID], ToReviewerName: names[h.ToReviewerID], CreatedByName: names[h.CreatedBy], VersionID: uuidToPtr(h.VersionID), FromReviewIssue: cards[h.FromReviewIssueID], ToReviewIssue: cards[h.ToReviewIssueID], Reason: h.Reason, CreatedBy: uuidToString(h.CreatedBy), CreatedAt: h.CreatedAt.Time.UTC().Format(time.RFC3339Nano), Revision: h.Revision}}
	}
	return out, nil
}
func (h *Handler) cockpitHistorySummary(r *http.Request, x *cockpitHistoryRead) (CockpitWorkflowSummaryResponse, error) {
	out := CockpitWorkflowSummaryResponse{Representation: "summary", WorkspaceID: uuidToString(x.cc.workspaceID), MeetingID: uuidToString(x.meetingID)}
	if x.work == nil {
		out.CanManage = x.human
		return out, nil
	}
	w := *x.work
	counts, err := x.q.CountCockpitWorkflowHistory(x.ctx, db.CountCockpitWorkflowHistoryParams{WorkspaceID: x.cc.workspaceID, MeetingID: x.meetingID})
	if err != nil {
		return out, err
	}
	out.HistoryCounts = CockpitWorkflowHistoryCounts{Versions: counts.Versions, ReviewerHandoffs: counts.ReviewerHandoffs, NASExports: counts.NasExports, NASActive: counts.NasActive}
	cards, err := x.cards([]pgtype.UUID{w.MinutesIssueID})
	if err != nil {
		return out, err
	}
	meta, err := x.metadata([]pgtype.UUID{w.CurrentVersionID, w.PublishedVersionID})
	if err != nil {
		return out, err
	}
	if w.CurrentVersionID.Valid {
		v, ok := meta[w.CurrentVersionID]
		if !ok {
			return out, service.ErrCockpitWorkflowNotFound
		}
		out.CurrentVersion = &v
	}
	if w.PublishedVersionID.Valid {
		v, ok := meta[w.PublishedVersionID]
		if !ok {
			return out, service.ErrCockpitWorkflowNotFound
		}
		out.PublishedVersion = &v
	}
	out.Enabled = true
	out.Revision = w.Revision
	out.EndedAt = cockpitWorkflowTime(w.EndedAt)
	out.MaterialsReady = w.MaterialsReady
	out.ReleasedAt = cockpitWorkflowTime(w.ReleasedAt)
	out.ReleaseTaskID = uuidToPtr(w.ReleaseTaskID)
	out.ReviewerID = uuidToPtr(w.ReviewerID)
	out.MinutesIssue = cards[w.MinutesIssueID]
	out.CurrentVersionID = uuidToPtr(w.CurrentVersionID)
	out.PublishedVersionID = uuidToPtr(w.PublishedVersionID)
	out.CanManage = x.human && x.manager()
	out.CanReassignReviewer = out.CanManage
	out.CanSubmit = h.canSubmitCockpitMinutes(r, x.q, x.cc, w, out.MinutesIssue)
	if v := out.CurrentVersion; v != nil && x.human {
		out.CanReview = v.ReviewerID == uuidToString(x.cc.member.UserID) && v.Decision == "pending"
		out.CanPublish = (out.CanManage || v.ReviewerID == uuidToString(x.cc.member.UserID)) && v.Decision == "approved"
	}
	if v := out.PublishedVersion; v != nil {
		out.CanExportNAS = x.canExport(*v)
	}
	out.NASUnavailableReason = "not_configured"
	if exporter := h.IssueService.CockpitNASExporter; exporter != nil {
		preview, e := exporter.Preview(uuidToString(x.cc.workspaceID), x.nasDir)
		if e != nil {
			var detail *cockpitnas.Error
			if errors.As(e, &detail) {
				out.NASUnavailableReason = detail.Code
			}
		} else {
			out.NASDestination = &preview
			out.NASUnavailableReason = ""
			if out.PublishedVersion != nil {
				dest, e := exporter.Resolve(uuidToString(x.cc.workspaceID), preview.Directory, out.PublishedVersion.ID, out.PublishedVersion.VersionNumber)
				if e != nil {
					return out, e
				}
				job, e := x.q.GetCockpitMinutesExportDestination(x.ctx, db.GetCockpitMinutesExportDestinationParams{WorkspaceID: x.cc.workspaceID, VersionID: w.PublishedVersionID, RootID: dest.RootID, RelativePath: dest.RelativePath})
				if e != nil && !errors.Is(e, pgx.ErrNoRows) {
					return out, e
				}
				if e == nil {
					items, e := x.exports([]pgtype.UUID{job.ID})
					if e != nil {
						return out, e
					}
					pin := items[job.ID]
					out.PublishedNASExport = &pin
				}
			}
		}
	}
	return out, nil
}
