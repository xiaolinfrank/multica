package service

import (
	"context"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"time"
)

func acceptanceHandoffView(r db.CockpitAcceptanceReviewerHandoff) CockpitAcceptanceReviewerHandoff {
	return CockpitAcceptanceReviewerHandoff{ID: util.UUIDToString(r.ID), NodeID: util.UUIDToString(r.NodeID), RequestID: util.UUIDToString(r.RequestID), HandoffKey: util.UUIDToString(r.CommandKey), FromReviewerID: util.UUIDToString(r.FromReviewerID), ToReviewerID: util.UUIDToString(r.ToReviewerID), FromReviewIssueID: util.UUIDToString(r.FromReviewIssueID), ToReviewIssueID: util.UUIDToString(r.ToReviewIssueID), Reason: r.Reason, CreatedBy: util.UUIDToString(r.CreatedBy), CreatedAt: r.CreatedAt.Time.UTC().Format(time.RFC3339Nano), Revision: r.ResultingRevision}
}
func enrichAcceptanceHandoffs(ctx context.Context, q *db.Queries, items []CockpitAcceptanceReviewerHandoff) error {
	ids := []string{}
	for _, r := range items {
		ids = append(ids, r.FromReviewerID, r.ToReviewerID, r.CreatedBy)
	}
	names, err := artifactUserNames(ctx, q, ids)
	if err != nil {
		return err
	}
	for i := range items {
		items[i].FromReviewerName = names[items[i].FromReviewerID]
		items[i].ToReviewerName = names[items[i].ToReviewerID]
		items[i].CreatedByName = names[items[i].CreatedBy]
	}
	return nil
}
func (s *IssueService) ReassignCockpitAcceptanceReviewer(ctx context.Context, p CockpitAcceptanceReviewerCommand, opts IssueCreateOpts) (CockpitAcceptanceHandoffResponse, error) {
	if !p.Human {
		return CockpitAcceptanceHandoffResponse{}, ErrCockpitWorkflowForbidden
	}
	if !p.HandoffKey.Valid || !p.ReviewerID.Valid {
		return CockpitAcceptanceHandoffResponse{}, ErrCockpitWorkflowInput
	}
	var err error
	p.Reason, err = artifactReason(p.Reason)
	if err != nil {
		return CockpitAcceptanceHandoffResponse{}, err
	}
	h := &cockpitArtifactIssue{acceptanceReviewer: &p}
	_, err = s.Create(ctx, IssueCreateParams{WorkspaceID: p.WorkspaceID, CreatorID: p.ActorID, CreatorType: "member", CockpitArtifact: h}, opts)
	if err != nil {
		return CockpitAcceptanceHandoffResponse{}, err
	}
	s.finalizeAcceptanceRetired(ctx, h, p.ActorID, p.WorkspaceID)
	s.acceptanceChanged(p.WorkspaceID, p.NodeID, p.ActorID)
	read := CockpitAcceptanceRead{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID, NodeID: p.NodeID, RequestID: p.RequestID, Human: p.Human}
	header, err := s.GetCockpitAcceptance(ctx, read)
	if err != nil {
		return CockpitAcceptanceHandoffResponse{}, err
	}
	request, err := s.GetCockpitAcceptanceRequest(ctx, read)
	if err != nil {
		return CockpitAcceptanceHandoffResponse{}, err
	}
	items := []CockpitAcceptanceReviewerHandoff{acceptanceHandoffView(h.acceptanceHandoff)}
	if err = enrichAcceptanceHandoffs(ctx, s.Queries, items); err != nil {
		return CockpitAcceptanceHandoffResponse{}, err
	}
	return CockpitAcceptanceHandoffResponse{WorkspaceID: util.UUIDToString(p.WorkspaceID), Acceptance: header, Request: request, Handoff: items[0]}, nil
}
func prepareCockpitAcceptanceReviewerIssue(ctx context.Context, q *db.Queries, p *IssueCreateParams) (*db.Issue, error) {
	h := p.CockpitArtifact
	in := *h.acceptanceReviewer
	m, err := lockArtifactWorkspace(ctx, q, in.WorkspaceID, in.ActorID)
	if err != nil {
		return nil, err
	}
	node, project, module, err := requireExecutionLeaf(ctx, q, in.WorkspaceID, in.NodeID)
	if err != nil {
		return nil, err
	}
	d, err := q.LockCockpitAcceptanceDefinition(ctx, db.LockCockpitAcceptanceDefinitionParams{WorkspaceID: in.WorkspaceID, NodeID: in.NodeID})
	if err != nil {
		return nil, cockpitWorkflowError(err)
	}
	h.acceptanceDefinition = d

	old, err := q.GetCockpitAcceptanceReviewerHandoffByKey(ctx, db.GetCockpitAcceptanceReviewerHandoffByKeyParams{WorkspaceID: in.WorkspaceID, NodeID: in.NodeID, CommandKey: in.HandoffKey})
	if err == nil {
		if old.RequestHash != planningHash(in) || old.CreatedBy != in.ActorID {
			return nil, ErrCockpitWorkflowConflict
		}
		h.acceptanceHandoff = old
		i, e := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: in.WorkspaceID, ID: old.ToReviewIssueID})
		return &i, cockpitWorkflowError(e)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if !acceptanceManager(d, in.ActorID, m.Role, in.Human) {
		return nil, ErrCockpitWorkflowForbidden
	}
	r, err := q.GetCockpitAcceptanceRequest(ctx, db.GetCockpitAcceptanceRequestParams{WorkspaceID: in.WorkspaceID, NodeID: in.NodeID, ID: in.RequestID})
	if err != nil {
		return nil, cockpitWorkflowError(err)
	}
	if err = artifactExpected(r.Revision, in.ExpectedRevision); err != nil {
		return nil, err
	}
	if r.ID != d.CurrentRequestID || r.Decision != "pending" || r.SupersededAt.Valid {
		return nil, artifactConflict("only the current pending acceptance request can be handed over")
	}
	if r.ReviewerID == in.ReviewerID {
		return nil, artifactInput("choose a different reviewer")
	}
	if err = artifactReviewer(ctx, q, in.WorkspaceID, in.ReviewerID); err != nil {
		return nil, err
	}
	oldIssue, err := q.LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{WorkspaceID: in.WorkspaceID, ID: r.ReviewIssueID})
	if err != nil {
		return nil, cockpitWorkflowError(err)
	}
	h.retiredPreviousStatus = oldIssue.Status
	h.acceptanceRequest = r
	p.Title = "Accept L3: " + node.Name
	p.Description = pgtype.Text{String: fmt.Sprintf("Formal review responsibility for acceptance request %s (L3 %s) was handed over. Review the fixed conditions and evidence in the acceptance reader.", util.UUIDToString(r.ID), util.UUIDToString(node.ID)), Valid: true}
	p.Status = "todo"
	p.Priority = "none"
	p.ProjectID = project
	p.ModuleID = module
	p.AssigneeType = pgtype.Text{String: "member", Valid: true}
	p.AssigneeID = in.ReviewerID
	p.ParentIssueID = pgtype.UUID{}
	p.AllowDuplicate = true
	return nil, nil
}
func linkCockpitAcceptanceReviewerIssue(ctx context.Context, q *db.Queries, p IssueCreateParams, issue db.Issue) error {
	h := p.CockpitArtifact
	in := *h.acceptanceReviewer
	r := h.acceptanceRequest
	updated, err := q.SetCockpitAcceptanceRequestReviewer(ctx, db.SetCockpitAcceptanceRequestReviewerParams{WorkspaceID: in.WorkspaceID, NodeID: in.NodeID, ID: r.ID, ReviewerID: in.ReviewerID, ReviewIssueID: issue.ID})
	if err != nil {
		return err
	}
	h.acceptanceHandoff, err = q.CreateCockpitAcceptanceReviewerHandoff(ctx, db.CreateCockpitAcceptanceReviewerHandoffParams{ID: dbid.NewV7(), WorkspaceID: in.WorkspaceID, NodeID: in.NodeID, RequestID: r.ID, CommandKey: in.HandoffKey, RequestHash: planningHash(in), FromReviewerID: r.ReviewerID, ToReviewerID: in.ReviewerID, FromReviewIssueID: r.ReviewIssueID, ToReviewIssueID: issue.ID, Reason: in.Reason, CreatedBy: in.ActorID, ExpectedRevision: in.ExpectedRevision, ResultingRevision: updated.Revision})
	if err != nil {
		return err
	}
	if _, err = q.CreateCockpitIssuePrimary(ctx, db.CreateCockpitIssuePrimaryParams{WorkspaceID: in.WorkspaceID, IssueID: issue.ID, NodeID: in.NodeID, CreatedBy: in.ActorID}); err != nil {
		return err
	}
	h.retired, err = q.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{WorkspaceID: in.WorkspaceID, ID: r.ReviewIssueID, Status: "cancelled"})
	if err != nil {
		return err
	}
	h.cancelled, err = StopClosedIssueWakeups(ctx, q, h.retired)
	h.acceptanceRequest = updated
	return err
}
func (s *IssueService) ListCockpitAcceptanceReviewerHandoffs(ctx context.Context, p CockpitAcceptanceRead) (CockpitAcceptanceHandoffPage, error) {
	size, err := planningPageSize(p.PageSize)
	if err != nil {
		return CockpitAcceptanceHandoffPage{}, err
	}
	scope := planningHash([]any{"acceptance-handoffs", p.WorkspaceID, p.NodeID, size})
	after, _, err := decodePlanningCursor(p.Cursor, scope)
	if err != nil {
		return CockpitAcceptanceHandoffPage{}, err
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitAcceptanceHandoffPage{}, err
	}
	defer tx.Rollback(ctx)
	if _, _, err = acceptanceReadContext(ctx, q, p); err != nil {
		return CockpitAcceptanceHandoffPage{}, err
	}
	rows, err := q.ListCockpitAcceptanceReviewerHandoffs(ctx, db.ListCockpitAcceptanceReviewerHandoffsParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, AfterID: after, PageLimit: size + 1})
	if err != nil {
		return CockpitAcceptanceHandoffPage{}, err
	}
	total, err := q.CountCockpitAcceptanceReviewerHandoffs(ctx, db.CountCockpitAcceptanceReviewerHandoffsParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID})
	if err != nil {
		return CockpitAcceptanceHandoffPage{}, err
	}
	out := CockpitAcceptanceHandoffPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), NodeID: util.UUIDToString(p.NodeID), Items: []CockpitAcceptanceReviewerHandoff{}, Total: total}
	if len(rows) > int(size) {
		rows = rows[:size]
		out.NextCursor = encodePlanningCursor(scope, rows[len(rows)-1].ID, 0)
	}
	for _, r := range rows {
		out.Items = append(out.Items, acceptanceHandoffView(r))
	}
	if err = enrichAcceptanceHandoffs(ctx, q, out.Items); err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
