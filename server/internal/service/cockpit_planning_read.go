package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type planningCursor struct {
	Scope  string `json:"scope"`
	ID     string `json:"id"`
	Number int32  `json:"number,omitempty"`
}

func planningPageSize(size int32) (int32, error) {
	if size == 0 {
		return 25, nil
	}
	if size < 1 || size > 100 {
		return 0, fmt.Errorf("%w: page_size must be 1–100", ErrCockpitWorkflowInput)
	}
	return size, nil
}
func decodePlanningCursor(value, scope string) (pgtype.UUID, int32, error) {
	if value == "" {
		return pgtype.UUID{}, 0, nil
	}
	var c planningCursor
	b, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(value) > 4096 || json.Unmarshal(b, &c) != nil || c.Scope != scope {
		return pgtype.UUID{}, 0, fmt.Errorf("%w: cursor does not match this scope and filter", ErrCockpitWorkflowInput)
	}
	id, err := util.ParseUUID(c.ID)
	if err != nil || !id.Valid {
		return pgtype.UUID{}, 0, fmt.Errorf("%w: invalid cursor", ErrCockpitWorkflowInput)
	}
	return id, c.Number, nil
}
func encodePlanningCursor(scope string, id pgtype.UUID, number int32) *string {
	b, _ := json.Marshal(planningCursor{Scope: scope, ID: util.UUIDToString(id), Number: number})
	s := base64.RawURLEncoding.EncodeToString(b)
	return &s
}
func (s *IssueService) beginPlanningRead(ctx context.Context) (pgx.Tx, *db.Queries, error) {
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	if _, err := tx.Exec(ctx, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"); err != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, err
	}
	return tx, s.Queries.WithTx(tx), nil
}
func planningIssueFact(row db.ListCockpitIssueFactsRow) CockpitIssueSummary {
	var due *string
	if row.DueDate.Valid {
		v := row.DueDate.Time.Format("2006-01-02")
		due = &v
	}
	return CockpitIssueSummary{ID: util.UUIDToString(row.ID), Identifier: row.Identifier, Title: row.Title, Status: row.Status, StatusCategory: row.StatusCategory,
		Priority: row.Priority, AssigneeType: planningText(row.AssigneeType), AssigneeID: planningUUID(row.AssigneeID), AssigneeName: row.AssigneeName,
		DueDate: due, ProjectID: planningUUID(row.ProjectID), ModuleID: planningUUID(row.ModuleID), PrimaryNodeID: planningUUID(row.PrimaryNodeID),
		PrimaryNodeCode: row.PrimaryNodeCode, PrimaryNodeName: row.PrimaryNodeName, PrimaryRevision: row.PrimaryRevision, CreationKey: planningUUID(row.CreationKey)}
}
func readPlanningIssueFacts(ctx context.Context, q *db.Queries, ws pgtype.UUID, ids []pgtype.UUID) (map[pgtype.UUID]CockpitIssueSummary, error) {
	facts := map[pgtype.UUID]CockpitIssueSummary{}
	if len(ids) == 0 {
		return facts, nil
	}
	rows, err := q.ListCockpitIssueFacts(ctx, db.ListCockpitIssueFactsParams{WorkspaceID: ws, IssueIds: ids})
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		facts[row.ID] = planningIssueFact(row)
	}
	return facts, nil
}
func (s *IssueService) ReadCockpitIssueSummary(ctx context.Context, ws, issue pgtype.UUID) (CockpitIssueSummary, error) {
	facts, err := readPlanningIssueFacts(ctx, s.Queries, ws, []pgtype.UUID{issue})
	if err != nil {
		return CockpitIssueSummary{}, err
	}
	if fact, ok := facts[issue]; ok {
		return fact, nil
	}
	return CockpitIssueSummary{}, ErrCockpitWorkflowNotFound
}
func (s *IssueService) GetCockpitIssuePrimaryNode(ctx context.Context, ws, issue pgtype.UUID) (CockpitPrimaryView, error) {
	fact, err := s.ReadCockpitIssueSummary(ctx, ws, issue)
	if err != nil {
		return CockpitPrimaryView{}, err
	}
	return CockpitPrimaryView{IssueID: fact.ID, NodeID: fact.PrimaryNodeID, NodeCode: fact.PrimaryNodeCode, NodeName: fact.PrimaryNodeName,
		Revision: fact.PrimaryRevision, ProjectID: fact.ProjectID, ModuleID: fact.ModuleID}, nil
}
func timestamp(value pgtype.Timestamptz) *string {
	if !value.Valid {
		return nil
	}
	v := value.Time.UTC().Format(time.RFC3339Nano)
	return &v
}
func planningActionView(row db.CockpitMeetingAction, work db.CockpitMeetingWorkPackage, facts map[pgtype.UUID]CockpitIssueSummary, actor, reviewer pgtype.UUID, role string, human, validSource bool) CockpitActionView {
	var resolution *string
	if row.Resolution != "" {
		v := row.Resolution
		resolution = &v
	}
	var issue *CockpitIssueSummary
	if value, ok := facts[row.IssueID]; ok {
		issue = &value
	}
	allowed := human && validSource && (actor == work.CreatedBy || actor == reviewer || role == "owner" || role == "admin")
	superseded := row.VersionID != work.PublishedVersionID
	return CockpitActionView{ID: util.UUIDToString(row.ID), MeetingID: util.UUIDToString(row.MeetingID), VersionID: util.UUIDToString(row.VersionID), VersionNumber: row.VersionNumber,
		SourceContentHash: row.SourceContentHash, SourceQuote: row.SourceQuote, Title: row.Title, Description: row.Description, Status: row.Status, Resolution: resolution, Revision: row.Revision,
		ProposalKey: util.UUIDToString(row.ProposalKey), DecisionKey: planningUUID(row.DecisionKey), NodeID: planningUUID(row.NodeID), NodeCode: row.NodeCode, NodeName: row.NodeName,
		Issue: issue, Reason: row.Reason, CreatedBy: util.UUIDToString(row.CreatedBy), CreatedAt: row.CreatedAt.Time.UTC().Format(time.RFC3339Nano), UpdatedAt: row.UpdatedAt.Time.UTC().Format(time.RFC3339Nano),
		ResolvedBy: planningUUID(row.ResolvedBy), ResolvedAt: timestamp(row.ResolvedAt), CanEdit: allowed && row.Status == "draft" && !superseded, CanResolve: allowed && row.Status == "draft", SourceSuperseded: superseded}
}
func (s *IssueService) GetCockpitMeetingAction(ctx context.Context, p CockpitActionRead) (CockpitActionView, error) {
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitActionView{}, err
	}
	defer tx.Rollback(ctx)
	a, err := q.GetCockpitMeetingAction(ctx, db.GetCockpitMeetingActionParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.ActionID})
	if err != nil {
		return CockpitActionView{}, planningError(err)
	}
	w, err := q.GetCockpitMeetingWorkPackage(ctx, db.GetCockpitMeetingWorkPackageParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID})
	if err != nil {
		return CockpitActionView{}, planningError(err)
	}
	v, err := q.GetCockpitActionVersionFact(ctx, db.GetCockpitActionVersionFactParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: a.VersionID})
	if err != nil {
		return CockpitActionView{}, planningError(err)
	}
	member, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{WorkspaceID: p.WorkspaceID, UserID: p.ActorID})
	if err != nil {
		return CockpitActionView{}, ErrCockpitWorkflowForbidden
	}
	ids := []pgtype.UUID{}
	if a.IssueID.Valid {
		ids = append(ids, a.IssueID)
	}
	facts, err := readPlanningIssueFacts(ctx, q, p.WorkspaceID, ids)
	if err != nil {
		return CockpitActionView{}, err
	}
	return planningActionView(a, w, facts, p.ActorID, v.ReviewerID, member.Role, p.Human, v.PublishedAt.Valid && v.Decision == "approved"), nil
}
func (s *IssueService) ListCockpitMeetingActions(ctx context.Context, p CockpitActionList) (CockpitActionPage, error) {
	p.Query = strings.TrimSpace(p.Query)
	size, err := planningPageSize(p.PageSize)
	if err != nil {
		return CockpitActionPage{}, err
	}
	if len(p.Query) > 512 || (p.Status != "" && p.Status != "draft" && p.Status != "accepted" && p.Status != "dismissed") {
		return CockpitActionPage{}, fmt.Errorf("%w: invalid action filter", ErrCockpitWorkflowInput)
	}
	scope := planningHash([]any{"actions", p.WorkspaceID, p.MeetingID, p.VersionID, p.Query, p.Status, size})
	cursor, _, err := decodePlanningCursor(p.Cursor, scope)
	if err != nil {
		return CockpitActionPage{}, err
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitActionPage{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := q.GetCockpitMeeting(ctx, db.GetCockpitMeetingParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID}); err != nil {
		return CockpitActionPage{}, planningError(err)
	}
	out := CockpitActionPage{MeetingID: util.UUIDToString(p.MeetingID), Items: []CockpitActionView{}}
	w, err := q.GetCockpitMeetingWorkPackage(ctx, db.GetCockpitMeetingWorkPackageParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID})
	if errors.Is(err, pgx.ErrNoRows) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	member, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{WorkspaceID: p.WorkspaceID, UserID: p.ActorID})
	if err != nil {
		return out, ErrCockpitWorkflowForbidden
	}
	if w.PublishedVersionID.Valid && (!p.VersionID.Valid || p.VersionID == w.PublishedVersionID) {
		v, err := q.GetCockpitActionVersionFact(ctx, db.GetCockpitActionVersionFactParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: w.PublishedVersionID})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return out, err
		}
		out.CanAdd = err == nil && p.Human && v.PublishedAt.Valid && v.Decision == "approved" && (p.ActorID == w.CreatedBy || p.ActorID == v.ReviewerID || member.Role == "owner" || member.Role == "admin")
	}
	counts, err := q.CountCockpitMeetingActions(ctx, db.CountCockpitMeetingActionsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, VersionID: p.VersionID, Status: p.Status, Query: p.Query})
	if err != nil {
		return out, err
	}
	out.Total, out.FilteredTotal = counts.Total, counts.FilteredTotal
	rows, err := q.ListCockpitMeetingActionsPage(ctx, db.ListCockpitMeetingActionsPageParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, VersionID: p.VersionID, Status: p.Status, Query: p.Query, CursorID: cursor, PageLimit: size + 1})
	if err != nil {
		return out, err
	}
	if len(rows) > int(size) {
		rows = rows[:size]
		out.NextCursor = encodePlanningCursor(scope, rows[len(rows)-1].ID, 0)
	}
	issues, versions := []pgtype.UUID{}, []pgtype.UUID{}
	for _, a := range rows {
		if a.IssueID.Valid {
			issues = append(issues, a.IssueID)
		}
		versions = append(versions, a.VersionID)
	}
	facts, err := readPlanningIssueFacts(ctx, q, p.WorkspaceID, issues)
	if err != nil {
		return out, err
	}
	vrows, err := q.ListCockpitActionVersionFacts(ctx, db.ListCockpitActionVersionFactsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, VersionIds: versions})
	if err != nil {
		return out, err
	}
	byVersion := map[pgtype.UUID]db.ListCockpitActionVersionFactsRow{}
	for _, v := range vrows {
		byVersion[v.ID] = v
	}
	for _, a := range rows {
		v := byVersion[a.VersionID]
		out.Items = append(out.Items, planningActionView(a, w, facts, p.ActorID, v.ReviewerID, member.Role, p.Human, v.PublishedAt.Valid && v.Decision == "approved"))
	}
	return out, nil
}
func (s *IssueService) ListCockpitNodeTasks(ctx context.Context, p CockpitNodeTaskList) (CockpitNodeTaskPage, error) {
	p.Query = strings.TrimSpace(p.Query)
	if p.Relation == "" {
		p.Relation = "primary"
	}
	size, err := planningPageSize(p.PageSize)
	if err != nil {
		return CockpitNodeTaskPage{}, err
	}
	if len(p.Query) > 512 || len(p.Status) > 100 || (p.Relation != "primary" && p.Relation != "reference") {
		return CockpitNodeTaskPage{}, fmt.Errorf("%w: invalid issue list filter", ErrCockpitWorkflowInput)
	}
	switch p.Category {
	case "", "active", "unstarted", "started", "done", "closed", "unknown":
	default:
		return CockpitNodeTaskPage{}, fmt.Errorf("%w: invalid category", ErrCockpitWorkflowInput)
	}
	scope := planningHash([]any{"node_tasks", p.WorkspaceID, p.NodeID, p.Query, p.Status, p.Category, p.Relation, size})
	cursor, number, err := decodePlanningCursor(p.Cursor, scope)
	if err != nil {
		return CockpitNodeTaskPage{}, err
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitNodeTaskPage{}, err
	}
	defer tx.Rollback(ctx)
	_, eligibility, err := executionLeaf(ctx, q, p.WorkspaceID, p.NodeID)
	if err != nil {
		return CockpitNodeTaskPage{}, err
	}
	out := CockpitNodeTaskPage{NodeID: util.UUIDToString(p.NodeID), Items: []CockpitIssueSummary{}, Eligibility: eligibility,
		Summary: CockpitNodeTaskSummary{ByStatus: []CockpitStatusCount{}, ByCategory: map[string]int64{"unstarted": 0, "started": 0, "done": 0, "closed": 0, "unknown": 0}}}
	counts, err := q.CountCockpitNodeTasksByStatus(ctx, db.CountCockpitNodeTasksByStatusParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, Query: p.Query, Status: p.Status, Category: p.Category, Relation: p.Relation})
	if err != nil {
		return out, err
	}
	for _, c := range counts {
		out.Total += c.Total
		out.FilteredTotal += c.FilteredTotal
		out.Summary.ByStatus = append(out.Summary.ByStatus, CockpitStatusCount{Status: c.Status, Category: c.Category, Count: c.Total})
		out.Summary.ByCategory[c.Category] += c.Total
	}
	out.Summary.Total = out.Total
	out.Summary.Done = out.Summary.ByCategory["done"]
	out.Summary.Closed = out.Summary.ByCategory["closed"]
	out.Summary.Unknown = out.Summary.ByCategory["unknown"]
	rows, err := q.ListCockpitNodeTaskIDs(ctx, db.ListCockpitNodeTaskIDsParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, Query: p.Query, Status: p.Status, Category: p.Category, Relation: p.Relation, CursorID: cursor, CursorNumber: number, PageLimit: size + 1})
	if err != nil {
		return out, err
	}
	if len(rows) > int(size) {
		rows = rows[:size]
		last := rows[len(rows)-1]
		out.NextCursor = encodePlanningCursor(scope, last.ID, last.Number)
	}
	ids := make([]pgtype.UUID, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	facts, err := readPlanningIssueFacts(ctx, q, p.WorkspaceID, ids)
	if err != nil {
		return out, err
	}
	for _, row := range rows {
		if fact, ok := facts[row.ID]; ok {
			out.Items = append(out.Items, fact)
		}
	}
	return out, nil
}
