package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func artifactReason(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 16000 || !utf8.ValidString(value) {
		return "", artifactInput("a reason of 1–16000 UTF-8 bytes is required")
	}
	return value, nil
}
func artifactProducerHash(p CockpitArtifactProducerCommand) string {
	return planningHash(struct {
		Actor, Issue pgtype.UUID
		Key          pgtype.UUID
		Expected     int64
		Reason       string
		New          *IssueCreateParams
	}{p.ActorID, p.IssueID, p.CommandKey, p.ExpectedRevision, p.Reason, p.NewIssue})
}
func artifactReviewerHash(p CockpitArtifactReviewerCommand) string {
	return planningHash(struct {
		Actor, Target, Key pgtype.UUID
		Expected           int64
		Reason             string
	}{p.ActorID, p.ReviewerID, p.HandoffKey, p.ExpectedRevision, p.Reason})
}
func producerView(r db.CockpitArtifactProducerAssignment) CockpitArtifactProducerAssignment {
	return CockpitArtifactProducerAssignment{ID: util.UUIDToString(r.ID), ArtifactID: util.UUIDToString(r.ArtifactID), CommandKey: util.UUIDToString(r.CommandKey), FromIssueID: util.UUIDToString(r.FromIssueID), ToIssueID: util.UUIDToString(r.ToIssueID), Reason: r.Reason, CreatedBy: util.UUIDToString(r.CreatedBy), CreatedAt: r.CreatedAt.Time.UTC().Format(time.RFC3339Nano), Revision: r.ResultingRevision}
}
func reviewerView(r db.CockpitArtifactReviewerHandoff) CockpitArtifactReviewerHandoff {
	var number *int32
	if r.VersionNumber.Valid {
		n := r.VersionNumber.Int32
		number = &n
	}
	return CockpitArtifactReviewerHandoff{ID: util.UUIDToString(r.ID), ArtifactID: util.UUIDToString(r.ArtifactID), HandoffKey: util.UUIDToString(r.CommandKey), FromReviewerID: util.UUIDToString(r.FromReviewerID), ToReviewerID: util.UUIDToString(r.ToReviewerID), VersionID: planningUUID(r.VersionID), VersionNumber: number, FromReviewIssueID: planningUUID(r.FromReviewIssueID), ToReviewIssueID: planningUUID(r.ToReviewIssueID), Reason: r.Reason, CreatedBy: util.UUIDToString(r.CreatedBy), CreatedAt: r.CreatedAt.Time.UTC().Format(time.RFC3339Nano), Revision: r.ResultingRevision}
}
func enrichArtifactProducers(ctx context.Context, q *db.Queries, ws pgtype.UUID, items []CockpitArtifactProducerAssignment) error {
	issueIDs, userIDs := []pgtype.UUID{}, []pgtype.UUID{}
	for _, r := range items {
		a, _ := util.ParseUUID(r.FromIssueID)
		b, _ := util.ParseUUID(r.ToIssueID)
		u, _ := util.ParseUUID(r.CreatedBy)
		issueIDs = append(issueIDs, a, b)
		userIDs = append(userIDs, u)
	}
	facts, err := readPlanningIssueFacts(ctx, q, ws, issueIDs)
	if err != nil {
		return err
	}
	users, err := q.GetUsersByIDs(ctx, userIDs)
	if err != nil {
		return err
	}
	names := map[string]string{}
	for _, u := range users {
		names[util.UUIDToString(u.ID)] = u.Name
	}
	for i := range items {
		a, _ := util.ParseUUID(items[i].FromIssueID)
		b, _ := util.ParseUUID(items[i].ToIssueID)
		items[i].FromIssueIdentifier = facts[a].Identifier
		items[i].FromIssueTitle = facts[a].Title
		items[i].ToIssueIdentifier = facts[b].Identifier
		items[i].ToIssueTitle = facts[b].Title
		items[i].CreatedByName = names[items[i].CreatedBy]
	}
	return nil
}
func artifactUserNames(ctx context.Context, q *db.Queries, values []string) (map[string]string, error) {
	ids := make([]pgtype.UUID, 0, len(values))
	for _, s := range values {
		id, e := util.ParseUUID(s)
		if e == nil {
			ids = append(ids, id)
		}
	}
	users, err := q.GetUsersByIDs(ctx, ids)
	if err != nil {
		return nil, err
	}
	names := map[string]string{}
	for _, u := range users {
		names[util.UUIDToString(u.ID)] = u.Name
	}
	return names, nil
}
func enrichArtifactHandoffs(ctx context.Context, q *db.Queries, items []CockpitArtifactReviewerHandoff) error {
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
func (s *IssueService) producerResponse(ctx context.Context, p CockpitArtifactProducerCommand, row db.CockpitArtifactProducerAssignment) (CockpitArtifactProducerResponse, error) {
	h, err := s.GetCockpitArtifact(ctx, CockpitArtifactRead{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID, ArtifactID: p.ArtifactID, Human: p.Human})
	if err != nil {
		return CockpitArtifactProducerResponse{}, err
	}
	issue, err := s.ReadCockpitIssueSummary(ctx, p.WorkspaceID, row.ToIssueID)
	if err != nil {
		return CockpitArtifactProducerResponse{}, err
	}
	items := []CockpitArtifactProducerAssignment{producerView(row)}
	if err = enrichArtifactProducers(ctx, s.Queries, p.WorkspaceID, items); err != nil {
		return CockpitArtifactProducerResponse{}, err
	}
	return CockpitArtifactProducerResponse{WorkspaceID: util.UUIDToString(p.WorkspaceID), Artifact: h, Assignment: items[0], ToIssue: issue}, nil
}
func (s *IssueService) AssignCockpitArtifactProducer(ctx context.Context, p CockpitArtifactProducerCommand, opts IssueCreateOpts) (CockpitArtifactProducerResponse, error) {
	if !p.Human {
		return CockpitArtifactProducerResponse{}, ErrCockpitWorkflowForbidden
	}
	if !p.CommandKey.Valid || p.IssueID.Valid == (p.NewIssue != nil) {
		return CockpitArtifactProducerResponse{}, artifactInput("choose issue_id or new_issue and provide command_key")
	}
	var err error
	p.Reason, err = artifactReason(p.Reason)
	if err != nil {
		return CockpitArtifactProducerResponse{}, err
	}
	if p.NewIssue != nil {
		normalized := *p.NewIssue
		normalized.Title = strings.TrimSpace(normalized.Title)
		if normalized.Title == "" || utf8.RuneCountInString(normalized.Title) > 500 {
			return CockpitArtifactProducerResponse{}, artifactInput("a producer task title is required")
		}
		if err = normalizePlanningIssue(&normalized, p.ActorID); err != nil {
			return CockpitArtifactProducerResponse{}, err
		}
		p.NewIssue = &normalized
		hook := &cockpitArtifactIssue{producer: &p}
		_, err = s.Create(ctx, IssueCreateParams{WorkspaceID: p.WorkspaceID, CreatorID: p.ActorID, CreatorType: "member", CockpitArtifact: hook}, opts)
		if err != nil {
			return CockpitArtifactProducerResponse{}, err
		}
		s.artifactChanged(hook.artifact, p.ActorID)
		return s.producerResponse(ctx, p, hook.assignment)
	}
	tx, q, a, m, err := s.beginArtifact(ctx, p.CockpitArtifactCommand)
	if err != nil {
		return CockpitArtifactProducerResponse{}, err
	}
	defer tx.Rollback(ctx)

	old, err := q.GetCockpitArtifactProducerAssignmentByKey(ctx, db.GetCockpitArtifactProducerAssignmentByKeyParams{WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID, CommandKey: p.CommandKey})
	if err == nil {
		if old.RequestHash != artifactProducerHash(p) || old.CreatedBy != p.ActorID {
			return CockpitArtifactProducerResponse{}, ErrCockpitWorkflowConflict
		}
		_ = tx.Rollback(ctx)
		return s.producerResponse(ctx, p, old)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return CockpitArtifactProducerResponse{}, err
	}
	if !artifactManager(a, p.ActorID, m.Role, p.Human) {
		return CockpitArtifactProducerResponse{}, ErrCockpitWorkflowForbidden
	}
	if err = artifactExpected(a.Revision, p.ExpectedRevision); err != nil {
		return CockpitArtifactProducerResponse{}, err
	}
	if a.ArchivedAt.Valid || a.AuthorizedProducerIssueID == p.IssueID {
		return CockpitArtifactProducerResponse{}, artifactInput("choose a different producer for an active artifact")
	}
	issue, err := q.LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{WorkspaceID: p.WorkspaceID, ID: p.IssueID})
	if err != nil {
		return CockpitArtifactProducerResponse{}, cockpitWorkflowError(err)
	}
	if issue.ProjectID != a.ProjectID || issue.ModuleID != a.ModuleID {
		return CockpitArtifactProducerResponse{}, artifactConflict("the producer must already belong to the artifact project and module")
	}
	row, updated, err := assignArtifactProducer(ctx, q, a, p, issue.ID)
	if err != nil {
		return CockpitArtifactProducerResponse{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return CockpitArtifactProducerResponse{}, err
	}
	s.artifactChanged(updated, p.ActorID)
	return s.producerResponse(ctx, p, row)
}
func assignArtifactProducer(ctx context.Context, q *db.Queries, a db.CockpitArtifact, p CockpitArtifactProducerCommand, issueID pgtype.UUID) (db.CockpitArtifactProducerAssignment, db.CockpitArtifact, error) {
	updated, err := q.SetCockpitArtifactProducer(ctx, db.SetCockpitArtifactProducerParams{WorkspaceID: a.WorkspaceID, ID: a.ID, AuthorizedProducerIssueID: issueID})
	if err != nil {
		return db.CockpitArtifactProducerAssignment{}, a, err
	}
	row, err := q.CreateCockpitArtifactProducerAssignment(ctx, db.CreateCockpitArtifactProducerAssignmentParams{ID: dbid.NewV7(), WorkspaceID: a.WorkspaceID, ArtifactID: a.ID, CommandKey: p.CommandKey, RequestHash: artifactProducerHash(p), FromIssueID: a.AuthorizedProducerIssueID, ToIssueID: issueID, Reason: p.Reason, CreatedBy: p.ActorID, ExpectedRevision: p.ExpectedRevision, ResultingRevision: updated.Revision})
	return row, updated, err
}
func prepareCockpitArtifactProducerIssue(ctx context.Context, q *db.Queries, p *IssueCreateParams) (*db.Issue, error) {
	h := p.CockpitArtifact
	in := *h.producer
	m, err := lockArtifactWorkspace(ctx, q, in.WorkspaceID, in.ActorID)
	if err != nil {
		return nil, err
	}
	a, err := q.LockCockpitArtifact(ctx, db.LockCockpitArtifactParams{WorkspaceID: in.WorkspaceID, ID: in.ArtifactID})
	if err != nil {
		return nil, cockpitWorkflowError(err)
	}
	h.artifact = a

	old, err := q.GetCockpitArtifactProducerAssignmentByKey(ctx, db.GetCockpitArtifactProducerAssignmentByKeyParams{WorkspaceID: in.WorkspaceID, ArtifactID: in.ArtifactID, CommandKey: in.CommandKey})
	if err == nil {
		if old.RequestHash != artifactProducerHash(in) || old.CreatedBy != in.ActorID {
			return nil, ErrCockpitWorkflowConflict
		}
		h.assignment = old
		i, e := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: in.WorkspaceID, ID: old.ToIssueID})
		return &i, cockpitWorkflowError(e)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if !artifactManager(a, in.ActorID, m.Role, in.Human) {
		return nil, ErrCockpitWorkflowForbidden
	}
	if err = artifactExpected(a.Revision, in.ExpectedRevision); err != nil {
		return nil, err
	}
	if a.ArchivedAt.Valid {
		return nil, ErrCockpitWorkflowConflict
	}
	original := p.CockpitArtifact
	*p = *in.NewIssue
	p.CockpitArtifact = original
	p.WorkspaceID = in.WorkspaceID
	p.ProjectID = a.ProjectID
	p.ModuleID = a.ModuleID
	p.CreatorType = "member"
	p.CreatorID = in.ActorID
	p.Status = "backlog"
	p.ParentIssueID = pgtype.UUID{}
	p.AllowDuplicate = true
	// Revalidate the selected actor through the same workspace and invocation
	// rules as the bounded selector, using this transaction's query handle.
	if err = validateArtifactProducerAssignee(ctx, q, in.WorkspaceID, in.ActorID, p.AssigneeType.String, p.AssigneeID); err != nil {
		return nil, err
	}
	return nil, nil
}
func linkCockpitArtifactProducerIssue(ctx context.Context, q *db.Queries, p IssueCreateParams, issue db.Issue) error {
	h := p.CockpitArtifact
	var err error
	h.assignment, h.artifact, err = assignArtifactProducer(ctx, q, h.artifact, *h.producer, issue.ID)
	if err != nil {
		return err
	}
	_, err = q.CreateCockpitIssuePrimary(ctx, db.CreateCockpitIssuePrimaryParams{WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, NodeID: h.artifact.OwnerNodeID, CreatedBy: h.producer.ActorID})
	return err
}
func (s *IssueService) ListCockpitArtifactProducerHistory(ctx context.Context, p CockpitArtifactRead) (CockpitArtifactProducerPage, error) {
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitArtifactProducerPage{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = artifactReadMember(ctx, q, p); err != nil {
		return CockpitArtifactProducerPage{}, err
	}
	if _, err = q.GetCockpitArtifact(ctx, db.GetCockpitArtifactParams{WorkspaceID: p.WorkspaceID, ID: p.ArtifactID}); err != nil {
		return CockpitArtifactProducerPage{}, cockpitWorkflowError(err)
	}
	size, err := planningPageSize(p.PageSize)
	if err != nil {
		return CockpitArtifactProducerPage{}, err
	}
	scope := planningHash([]any{"artifact-producers", p.WorkspaceID, p.ArtifactID, size})
	after, _, err := decodePlanningCursor(p.Cursor, scope)
	if err != nil {
		return CockpitArtifactProducerPage{}, err
	}
	rows, err := q.ListCockpitArtifactProducerAssignments(ctx, db.ListCockpitArtifactProducerAssignmentsParams{WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID, AfterID: after, PageLimit: size + 1})
	if err != nil {
		return CockpitArtifactProducerPage{}, err
	}
	total, err := q.CountCockpitArtifactProducerAssignments(ctx, db.CountCockpitArtifactProducerAssignmentsParams{WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID})
	if err != nil {
		return CockpitArtifactProducerPage{}, err
	}
	out := CockpitArtifactProducerPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), ArtifactID: util.UUIDToString(p.ArtifactID), Items: []CockpitArtifactProducerAssignment{}, Total: total}
	if len(rows) > int(size) {
		rows = rows[:size]
		out.NextCursor = encodePlanningCursor(scope, rows[len(rows)-1].ID, 0)
	}
	for _, r := range rows {
		out.Items = append(out.Items, producerView(r))
	}
	if err = enrichArtifactProducers(ctx, q, p.WorkspaceID, out.Items); err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
func (s *IssueService) artifactHandoffResponse(ctx context.Context, p CockpitArtifactReviewerCommand, row db.CockpitArtifactReviewerHandoff) (CockpitArtifactHandoffResponse, error) {
	h, err := s.GetCockpitArtifact(ctx, CockpitArtifactRead{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID, ArtifactID: p.ArtifactID, Human: p.Human})
	if err != nil {
		return CockpitArtifactHandoffResponse{}, err
	}
	out := CockpitArtifactHandoffResponse{WorkspaceID: util.UUIDToString(p.WorkspaceID), Artifact: h}
	items := []CockpitArtifactReviewerHandoff{reviewerView(row)}
	if err = enrichArtifactHandoffs(ctx, s.Queries, items); err != nil {
		return out, err
	}
	out.Handoff = items[0]
	if row.VersionID.Valid {
		read := CockpitArtifactRead{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID, ArtifactID: p.ArtifactID, VersionID: row.VersionID, Human: p.Human}
		v, e := s.readArtifactVersionMetadata(ctx, read)
		if e != nil {
			return out, e
		}
		out.Version = &v
	}
	return out, nil
}
func (s *IssueService) ReassignCockpitArtifactReviewer(ctx context.Context, p CockpitArtifactReviewerCommand, opts IssueCreateOpts) (CockpitArtifactHandoffResponse, error) {
	if !p.Human {
		return CockpitArtifactHandoffResponse{}, ErrCockpitWorkflowForbidden
	}
	if !p.HandoffKey.Valid || !p.ReviewerID.Valid {
		return CockpitArtifactHandoffResponse{}, ErrCockpitWorkflowInput
	}
	var err error
	p.Reason, err = artifactReason(p.Reason)
	if err != nil {
		return CockpitArtifactHandoffResponse{}, err
	}
	tx, q, a, m, err := s.beginArtifact(ctx, p.CockpitArtifactCommand)
	if err != nil {
		return CockpitArtifactHandoffResponse{}, err
	}
	defer tx.Rollback(ctx)

	old, err := q.GetCockpitArtifactReviewerHandoffByKey(ctx, db.GetCockpitArtifactReviewerHandoffByKeyParams{WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID, CommandKey: p.HandoffKey})
	if err == nil {
		if old.RequestHash != artifactReviewerHash(p) || old.CreatedBy != p.ActorID {
			return CockpitArtifactHandoffResponse{}, ErrCockpitWorkflowConflict
		}
		_ = tx.Rollback(ctx)
		return s.artifactHandoffResponse(ctx, p, old)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return CockpitArtifactHandoffResponse{}, err
	}
	if !artifactManager(a, p.ActorID, m.Role, p.Human) {
		return CockpitArtifactHandoffResponse{}, ErrCockpitWorkflowForbidden
	}
	if err = artifactExpected(a.Revision, p.ExpectedRevision); err != nil {
		return CockpitArtifactHandoffResponse{}, err
	}
	if a.ArchivedAt.Valid || a.ReviewerID == p.ReviewerID {
		return CockpitArtifactHandoffResponse{}, artifactInput("choose a different reviewer for an active artifact")
	}
	if err = artifactReviewer(ctx, q, p.WorkspaceID, p.ReviewerID); err != nil {
		return CockpitArtifactHandoffResponse{}, err
	}
	var v db.CockpitArtifactVersion
	if a.CurrentVersionID.Valid {
		v, err = q.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID, ID: a.CurrentVersionID})
		if err != nil {
			return CockpitArtifactHandoffResponse{}, err
		}
	}
	if v.Decision == "pending" {
		_ = tx.Rollback(ctx)
		hook := &cockpitArtifactIssue{reviewer: &p}
		_, err = s.Create(ctx, IssueCreateParams{WorkspaceID: p.WorkspaceID, CreatorID: p.ActorID, CreatorType: "member", CockpitArtifact: hook}, opts)
		if err != nil {
			return CockpitArtifactHandoffResponse{}, err
		}
		s.finalizeArtifactRetiredReview(ctx, hook, p.ActorID)
		s.artifactChanged(hook.artifact, p.ActorID)
		return s.artifactHandoffResponse(ctx, p, hook.handoff)
	}
	original := a
	a, err = q.SetCockpitArtifactReviewer(ctx, db.SetCockpitArtifactReviewerParams{WorkspaceID: p.WorkspaceID, ID: p.ArtifactID, ReviewerID: p.ReviewerID})
	if err != nil {
		return CockpitArtifactHandoffResponse{}, err
	}
	if v.ID.Valid && v.Decision == "not_requested" {
		v, err = q.SetCockpitArtifactVersionReviewer(ctx, db.SetCockpitArtifactVersionReviewerParams{WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID, ID: v.ID, ReviewerID: p.ReviewerID})
		if err != nil {
			return CockpitArtifactHandoffResponse{}, err
		}
	} else {
		v = db.CockpitArtifactVersion{}
	}
	row, err := recordArtifactHandoff(ctx, q, original, a, p, v, pgtype.UUID{}, pgtype.UUID{})
	if err != nil {
		return CockpitArtifactHandoffResponse{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return CockpitArtifactHandoffResponse{}, err
	}
	s.artifactChanged(a, p.ActorID)
	return s.artifactHandoffResponse(ctx, p, row)
}
func recordArtifactHandoff(ctx context.Context, q *db.Queries, old, updated db.CockpitArtifact, p CockpitArtifactReviewerCommand, v db.CockpitArtifactVersion, from, to pgtype.UUID) (db.CockpitArtifactReviewerHandoff, error) {
	return q.CreateCockpitArtifactReviewerHandoff(ctx, db.CreateCockpitArtifactReviewerHandoffParams{ID: dbid.NewV7(), WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID, CommandKey: p.HandoffKey, RequestHash: artifactReviewerHash(p), FromReviewerID: old.ReviewerID, ToReviewerID: p.ReviewerID, VersionID: v.ID, VersionNumber: pgtype.Int4{Int32: v.VersionNumber, Valid: v.ID.Valid}, FromReviewIssueID: from, ToReviewIssueID: to, Reason: p.Reason, CreatedBy: p.ActorID, ExpectedRevision: p.ExpectedRevision, ResultingRevision: updated.Revision})
}
func prepareCockpitArtifactReviewerIssue(ctx context.Context, q *db.Queries, p *IssueCreateParams) (*db.Issue, error) {
	h := p.CockpitArtifact
	in := *h.reviewer
	m, err := lockArtifactWorkspace(ctx, q, in.WorkspaceID, in.ActorID)
	if err != nil {
		return nil, err
	}
	a, err := q.LockCockpitArtifact(ctx, db.LockCockpitArtifactParams{WorkspaceID: in.WorkspaceID, ID: in.ArtifactID})
	if err != nil {
		return nil, cockpitWorkflowError(err)
	}
	h.artifact = a

	old, err := q.GetCockpitArtifactReviewerHandoffByKey(ctx, db.GetCockpitArtifactReviewerHandoffByKeyParams{WorkspaceID: in.WorkspaceID, ArtifactID: in.ArtifactID, CommandKey: in.HandoffKey})
	if err == nil {
		if old.RequestHash != artifactReviewerHash(in) || old.CreatedBy != in.ActorID {
			return nil, ErrCockpitWorkflowConflict
		}
		h.handoff = old
		i, e := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: in.WorkspaceID, ID: old.ToReviewIssueID})
		return &i, cockpitWorkflowError(e)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if !artifactManager(a, in.ActorID, m.Role, in.Human) {
		return nil, ErrCockpitWorkflowForbidden
	}
	if err = artifactExpected(a.Revision, in.ExpectedRevision); err != nil {
		return nil, err
	}
	if a.ArchivedAt.Valid || a.ReviewerID == in.ReviewerID {
		return nil, ErrCockpitWorkflowConflict
	}
	if err = artifactReviewer(ctx, q, in.WorkspaceID, in.ReviewerID); err != nil {
		return nil, err
	}
	v, err := q.LockCockpitArtifactVersion(ctx, db.LockCockpitArtifactVersionParams{WorkspaceID: in.WorkspaceID, ArtifactID: in.ArtifactID, ID: a.CurrentVersionID})
	if err != nil {
		return nil, cockpitWorkflowError(err)
	}
	if v.Decision != "pending" || v.CaptureStatus != "ready" {
		return nil, artifactConflict("the review changed while handing over responsibility")
	}
	h.version = v
	review, err := q.LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{WorkspaceID: in.WorkspaceID, ID: v.ReviewIssueID})
	if err != nil {
		return nil, cockpitWorkflowError(err)
	}
	h.retiredPreviousStatus = review.Status
	p.Title = fmt.Sprintf("Review artifact: %s · v%d", a.Title, v.VersionNumber)
	p.Description = pgtype.Text{String: fmt.Sprintf("Review responsibility for artifact %s version %s was explicitly handed over. Use its fixed version reader for the formal decision.", util.UUIDToString(a.ID), util.UUIDToString(v.ID)), Valid: true}
	p.Status = "todo"
	p.Priority = "none"
	p.ProjectID = a.ProjectID
	p.ModuleID = a.ModuleID
	p.AssigneeType = pgtype.Text{String: "member", Valid: true}
	p.AssigneeID = in.ReviewerID
	p.ParentIssueID = pgtype.UUID{}
	p.AllowDuplicate = true
	return nil, nil
}
func linkCockpitArtifactReviewerIssue(ctx context.Context, q *db.Queries, p IssueCreateParams, issue db.Issue) error {
	h := p.CockpitArtifact
	in := *h.reviewer
	old := h.artifact
	updated, err := q.SetCockpitArtifactReviewer(ctx, db.SetCockpitArtifactReviewerParams{WorkspaceID: in.WorkspaceID, ID: in.ArtifactID, ReviewerID: in.ReviewerID})
	if err != nil {
		return err
	}
	h.handoff, err = recordArtifactHandoff(ctx, q, old, updated, in, h.version, h.version.ReviewIssueID, issue.ID)
	if err != nil {
		return err
	}
	if _, err = q.SetCockpitArtifactVersionReviewer(ctx, db.SetCockpitArtifactVersionReviewerParams{WorkspaceID: in.WorkspaceID, ArtifactID: in.ArtifactID, ID: h.version.ID, ReviewerID: in.ReviewerID, ReviewIssueID: issue.ID}); err != nil {
		return err
	}
	if _, err = q.CreateCockpitIssuePrimary(ctx, db.CreateCockpitIssuePrimaryParams{WorkspaceID: in.WorkspaceID, IssueID: issue.ID, NodeID: old.OwnerNodeID, CreatedBy: in.ActorID}); err != nil {
		return err
	}
	h.retired, err = q.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{WorkspaceID: in.WorkspaceID, ID: h.version.ReviewIssueID, Status: "cancelled"})
	if err != nil {
		return err
	}
	h.cancelled, err = StopClosedIssueWakeups(ctx, q, h.retired)
	h.artifact = updated
	return err
}
func (s *IssueService) finalizeArtifactRetiredReview(ctx context.Context, h *cockpitArtifactIssue, actor pgtype.UUID) {
	if !h.retired.ID.Valid {
		return
	}
	s.publishCockpitWorkflowIssueUpdate(ctx, h.retired, actor, h.retiredPreviousStatus)
	if s.TaskService != nil {
		s.TaskService.FinalizeIssueTaskCancellations(ctx, util.UUIDToString(h.artifact.WorkspaceID), h.cancelled)
	}
}
func (s *IssueService) ListCockpitArtifactReviewerHandoffs(ctx context.Context, p CockpitArtifactRead) (CockpitArtifactHandoffPage, error) {
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitArtifactHandoffPage{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = artifactReadMember(ctx, q, p); err != nil {
		return CockpitArtifactHandoffPage{}, err
	}
	if _, err = q.GetCockpitArtifact(ctx, db.GetCockpitArtifactParams{WorkspaceID: p.WorkspaceID, ID: p.ArtifactID}); err != nil {
		return CockpitArtifactHandoffPage{}, cockpitWorkflowError(err)
	}
	size, err := planningPageSize(p.PageSize)
	if err != nil {
		return CockpitArtifactHandoffPage{}, err
	}
	scope := planningHash([]any{"artifact-reviewers", p.WorkspaceID, p.ArtifactID, size})
	after, _, err := decodePlanningCursor(p.Cursor, scope)
	if err != nil {
		return CockpitArtifactHandoffPage{}, err
	}
	rows, err := q.ListCockpitArtifactReviewerHandoffs(ctx, db.ListCockpitArtifactReviewerHandoffsParams{WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID, AfterID: after, PageLimit: size + 1})
	if err != nil {
		return CockpitArtifactHandoffPage{}, err
	}
	total, err := q.CountCockpitArtifactReviewerHandoffs(ctx, db.CountCockpitArtifactReviewerHandoffsParams{WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID})
	if err != nil {
		return CockpitArtifactHandoffPage{}, err
	}
	out := CockpitArtifactHandoffPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), ArtifactID: util.UUIDToString(p.ArtifactID), Items: []CockpitArtifactReviewerHandoff{}, Total: total}
	if len(rows) > int(size) {
		rows = rows[:size]
		out.NextCursor = encodePlanningCursor(scope, rows[len(rows)-1].ID, 0)
	}
	for _, r := range rows {
		out.Items = append(out.Items, reviewerView(r))
	}
	if err = enrichArtifactHandoffs(ctx, q, out.Items); err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
