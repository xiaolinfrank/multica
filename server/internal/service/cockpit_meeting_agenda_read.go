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

type lifecycleCursor struct {
	Scope    string `json:"scope"`
	Revision int64  `json:"revision"`
	ID       string `json:"id"`
	Order    int64  `json:"order"`
	Time     string `json:"time,omitempty"`
}

func lifecycleCursorScope(p CockpitLifecycleList, kind string) string {
	return planningHash(struct {
		Workspace, Meeting, Agenda pgtype.UUID
		Kind, Query                string
		Removed                    bool
		Size                       int32
	}{p.WorkspaceID, p.MeetingID, p.AgendaID, kind, p.Query, p.IncludeRemoved, p.PageSize})
}
func decodeLifecycleCursor(raw, scope string, revision int64) (lifecycleCursor, pgtype.UUID, error) {
	var c lifecycleCursor
	if raw == "" {
		return c, pgtype.UUID{}, nil
	}
	if len(raw) > 4096 {
		return c, pgtype.UUID{}, ErrCockpitWorkflowInput
	}
	b, e := base64.RawURLEncoding.DecodeString(raw)
	if e != nil || json.Unmarshal(b, &c) != nil || c.Scope != scope {
		return c, pgtype.UUID{}, fmt.Errorf("%w: cursor does not match this scope", ErrCockpitWorkflowInput)
	}
	if revision > 0 && c.Revision != revision {
		return c, pgtype.UUID{}, fmt.Errorf("%w: agenda changed; reload the first page", ErrCockpitWorkflowConflict)
	}
	id, e := util.ParseUUID(c.ID)
	if e != nil || !id.Valid {
		return c, id, ErrCockpitWorkflowInput
	}
	return c, id, nil
}
func encodeLifecycleCursor(c lifecycleCursor) *string {
	b, _ := json.Marshal(c)
	s := base64.RawURLEncoding.EncodeToString(b)
	return &s
}
func (s *IssueService) beginLifecycleRead(ctx context.Context, p CockpitLifecycleRead) (pgx.Tx, *db.Queries, lifecycleState, error) {
	tx, q, e := s.beginPlanningRead(ctx)
	if e != nil {
		return nil, nil, lifecycleState{}, e
	}
	if e = cockpitWorkflowMember(ctx, q, p.WorkspaceID, p.ActorID); e != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, lifecycleState{}, e
	}
	x, e := readLifecycleState(ctx, q, p)
	if e != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, x, e
	}
	return tx, q, x, nil
}
func agendaMetadata(r db.GetCockpitAgendaMetadataRow, p CockpitLifecycleRead) CockpitAgendaMetadata {
	purposes := r.Purposes
	if purposes == nil {
		purposes = []string{}
	}
	return CockpitAgendaMetadata{ID: util.UUIDToString(r.ID), WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), Revision: r.Revision, Title: r.Title, Purposes: purposes, SortOrder: r.SortOrder, FacilitatorUserID: planningUUID(r.FacilitatorUserID), FacilitatorName: r.FacilitatorName, NodeID: planningUUID(r.NodeID), NodeCode: r.NodeCode, NodeTitle: r.NodeTitle, ReferenceCount: r.ReferenceCount, CreatedAt: r.CreatedAt.Time.UTC().Format(time.RFC3339Nano), UpdatedAt: r.UpdatedAt.Time.UTC().Format(time.RFC3339Nano), RemovedAt: lifecycleTime(r.RemovedAt), CanEdit: p.Human && !r.RemovedAt.Valid, CanRemove: p.Human && !r.RemovedAt.Valid}
}
func agendaDetail(ctx context.Context, q *db.Queries, p CockpitLifecycleRead, a db.CockpitMeetingAgenda) (CockpitAgendaDetail, error) {
	meta, e := q.GetCockpitAgendaMetadata(ctx, db.GetCockpitAgendaMetadataParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: a.ID})
	if e != nil {
		return CockpitAgendaDetail{}, cockpitWorkflowError(e)
	}
	return CockpitAgendaDetail{CockpitAgendaMetadata: agendaMetadata(meta, p), DesiredOutcome: a.DesiredOutcome, Notes: a.Notes}, nil
}
func (s *IssueService) GetCockpitMeetingAgenda(ctx context.Context, p CockpitLifecycleRead, id pgtype.UUID) (CockpitAgendaDetail, error) {
	tx, q, _, e := s.beginLifecycleRead(ctx, p)
	if e != nil {
		return CockpitAgendaDetail{}, e
	}
	defer tx.Rollback(ctx)
	a, e := q.GetCockpitMeetingAgenda(ctx, db.GetCockpitMeetingAgendaParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: id})
	if e != nil {
		return CockpitAgendaDetail{}, cockpitWorkflowError(e)
	}
	return agendaDetail(ctx, q, p, a)
}
func (s *IssueService) ListCockpitMeetingAgenda(ctx context.Context, p CockpitLifecycleList) (CockpitAgendaPage, error) {
	var out CockpitAgendaPage
	p.Query = strings.TrimSpace(p.Query)
	size, e := planningPageSize(p.PageSize)
	if e != nil || len(p.Query) > 512 {
		if e == nil {
			e = ErrCockpitWorkflowInput
		}
		return out, e
	}
	p.PageSize = size
	tx, q, x, e := s.beginLifecycleRead(ctx, p.CockpitLifecycleRead)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	scope := lifecycleCursorScope(p, "agenda")
	c, id, e := decodeLifecycleCursor(p.Cursor, scope, x.meeting.AgendaRevision)
	if e != nil {
		return out, e
	}
	total, e := q.CountCockpitAgenda(ctx, db.CountCockpitAgendaParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, IncludeRemoved: p.IncludeRemoved, Query: p.Query})
	if e != nil {
		return out, e
	}
	rows, e := q.ListCockpitAgendaMetadata(ctx, db.ListCockpitAgendaMetadataParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, IncludeRemoved: p.IncludeRemoved, Query: p.Query, AfterID: id, AfterOrder: c.Order, PageLimit: size + 1})
	if e != nil {
		return out, e
	}
	out = CockpitAgendaPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), AgendaRevision: x.meeting.AgendaRevision, Query: p.Query, IncludeRemoved: p.IncludeRemoved, PageSize: size, Items: []CockpitAgendaMetadata{}, Total: total}
	if len(rows) > int(size) {
		rows = rows[:size]
		r := rows[len(rows)-1]
		out.NextCursor = encodeLifecycleCursor(lifecycleCursor{Scope: scope, Revision: x.meeting.AgendaRevision, ID: util.UUIDToString(r.ID), Order: r.SortOrder})
	}
	for _, row := range rows {
		out.Items = append(out.Items, agendaMetadata(db.GetCockpitAgendaMetadataRow(row), p.CockpitLifecycleRead))
	}
	return out, nil
}
func validateAgendaReferenceTarget(ctx context.Context, q *db.Queries, p CockpitLifecycleRead, kind string, target pgtype.UUID) error {
	switch kind {
	case "issue":
		_, e := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: target})
		return cockpitWorkflowError(e)
	case "artifact_reference":
		rows, e := q.ListCockpitAgendaArtifactTargets(ctx, db.ListCockpitAgendaArtifactTargetsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, Ids: []pgtype.UUID{target}})
		if e != nil {
			return e
		}
		if len(rows) != 1 || rows[0].RemovedAt.Valid {
			return fmt.Errorf("%w: fixed material reference is unavailable", ErrCockpitWorkflowConflict)
		}
		return nil
	default:
		return ErrCockpitWorkflowInput
	}
}
func readAgendaReferences(ctx context.Context, q *db.Queries, p CockpitLifecycleRead, rows []db.CockpitMeetingAgendaReference, agendaRemoved bool) ([]CockpitAgendaReferenceView, error) {
	issueIDs, artifactIDs := []pgtype.UUID{}, []pgtype.UUID{}
	for _, r := range rows {
		if r.Kind == "issue" {
			issueIDs = append(issueIDs, r.TargetID)
		} else {
			artifactIDs = append(artifactIDs, r.TargetID)
		}
	}
	facts, e := readPlanningIssueFacts(ctx, q, p.WorkspaceID, issueIDs)
	if e != nil {
		return nil, e
	}
	refs, e := q.ListCockpitAgendaArtifactTargets(ctx, db.ListCockpitAgendaArtifactTargetsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, Ids: artifactIDs})
	if e != nil {
		return nil, e
	}
	targets := map[pgtype.UUID]db.ListCockpitAgendaArtifactTargetsRow{}
	for _, r := range refs {
		targets[r.ID] = r
	}
	out := make([]CockpitAgendaReferenceView, 0, len(rows))
	for _, r := range rows {
		v := CockpitAgendaReferenceView{ID: util.UUIDToString(r.ID), WorkspaceID: util.UUIDToString(r.WorkspaceID), MeetingID: util.UUIDToString(r.MeetingID), AgendaID: util.UUIDToString(r.AgendaID), Kind: r.Kind, TargetID: util.UUIDToString(r.TargetID), Purpose: r.Purpose, CreatedAt: r.CreatedAt.Time.UTC().Format(time.RFC3339Nano), RemovedAt: lifecycleTime(r.RemovedAt), CanRemove: p.Human && !r.RemovedAt.Valid && !agendaRemoved}
		if r.Kind == "issue" {
			if f, ok := facts[r.TargetID]; ok {
				v.Issue = &f
				v.Label = f.Identifier + " · " + f.Title
				v.Available = true
			}
		} else if a, ok := targets[r.TargetID]; ok {
			v.Label = a.Title
			v.ArtifactID = planningUUID(a.ArtifactID)
			v.VersionID = planningUUID(a.VersionID)
			n := a.VersionNumber
			v.VersionNumber = &n
			v.ContentHash = planningText(a.ContentHash)
			decision := a.VersionDecision
			v.VersionDecision = &decision
			v.Available = !a.RemovedAt.Valid && a.ContentHash.Valid
		}
		out = append(out, v)
	}
	return out, nil
}
func (s *IssueService) ListCockpitMeetingAgendaReferences(ctx context.Context, p CockpitLifecycleList) (CockpitAgendaReferencePage, error) {
	var out CockpitAgendaReferencePage
	size, e := planningPageSize(p.PageSize)
	if e != nil {
		return out, e
	}
	p.PageSize = size
	tx, q, x, e := s.beginLifecycleRead(ctx, p.CockpitLifecycleRead)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	a, e := q.GetCockpitMeetingAgenda(ctx, db.GetCockpitMeetingAgendaParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.AgendaID})
	if e != nil {
		return out, cockpitWorkflowError(e)
	}
	scope := lifecycleCursorScope(p, "references")
	_, id, e := decodeLifecycleCursor(p.Cursor, scope, x.meeting.AgendaRevision)
	if e != nil {
		return out, e
	}
	count, e := q.CountCockpitAgendaReferences(ctx, db.CountCockpitAgendaReferencesParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, AgendaID: p.AgendaID, Column4: p.IncludeRemoved})
	if e != nil {
		return out, e
	}
	rows, e := q.ListCockpitAgendaReferences(ctx, db.ListCockpitAgendaReferencesParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, AgendaID: p.AgendaID, IncludeRemoved: p.IncludeRemoved, AfterID: id, PageLimit: size + 1})
	if e != nil {
		return out, e
	}
	out = CockpitAgendaReferencePage{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), AgendaID: util.UUIDToString(p.AgendaID), AgendaRevision: x.meeting.AgendaRevision, IncludeRemoved: p.IncludeRemoved, PageSize: size, Total: count}
	if len(rows) > int(size) {
		rows = rows[:size]
		out.NextCursor = encodeLifecycleCursor(lifecycleCursor{Scope: scope, Revision: x.meeting.AgendaRevision, ID: util.UUIDToString(rows[len(rows)-1].ID)})
	}
	out.Items, e = readAgendaReferences(ctx, q, p.CockpitLifecycleRead, rows, a.RemovedAt.Valid)
	return out, e
}
func (s *IssueService) ListCockpitMeetingLifecycleCommands(ctx context.Context, p CockpitLifecycleList) (CockpitLifecycleCommandPage, error) {
	var out CockpitLifecycleCommandPage
	size, e := planningPageSize(p.PageSize)
	if e != nil {
		return out, e
	}
	p.PageSize = size
	tx, q, _, e := s.beginLifecycleRead(ctx, p.CockpitLifecycleRead)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	scope := lifecycleCursorScope(p, "commands-newest")
	c, id, e := decodeLifecycleCursor(p.Cursor, scope, 0)
	if e != nil {
		return out, e
	}
	var after pgtype.Timestamptz
	if id.Valid {
		t, e := time.Parse(time.RFC3339Nano, c.Time)
		if e != nil {
			return out, ErrCockpitWorkflowInput
		}
		after = pgtype.Timestamptz{Time: t, Valid: true}
	}
	rows, e := q.ListCockpitLifecycleCommands(ctx, db.ListCockpitLifecycleCommandsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, AfterKey: id, AfterTime: after, PageLimit: size + 1})
	if e != nil {
		return out, e
	}
	count, e := q.CountCockpitLifecycleCommands(ctx, db.CountCockpitLifecycleCommandsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID})
	if e != nil {
		return out, e
	}
	out = CockpitLifecycleCommandPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), PageSize: size, Total: count, Items: []CockpitLifecycleCommandMetadata{}}
	if len(rows) > int(size) {
		rows = rows[:size]
		r := rows[len(rows)-1]
		out.NextCursor = encodeLifecycleCursor(lifecycleCursor{Scope: scope, ID: util.UUIDToString(r.CommandKey), Time: r.CreatedAt.Time.UTC().Format(time.RFC3339Nano)})
	}
	for _, r := range rows {
		out.Items = append(out.Items, CockpitLifecycleCommandMetadata{CommandKey: util.UUIDToString(r.CommandKey), Action: r.Kind, ActorType: r.ActorType, DirectoryOperationID: planningUUID(r.DirectoryOperationID), DirectoryStepID: planningUUID(r.DirectoryStepID), ActorID: util.UUIDToString(r.ActorID), ActorName: r.ActorName, CreatedAt: r.CreatedAt.Time.UTC().Format(time.RFC3339Nano), Revision: r.Revision, AgendaID: planningUUID(r.AgendaID), ReferenceID: planningUUID(r.ReferenceID), IssueID: planningUUID(r.IssueID), OperationID: planningUUID(r.OperationID), EffectID: planningUUID(r.EffectID)})
	}
	return out, nil
}
func loadActiveAgenda(ctx context.Context, q *db.Queries, p CockpitLifecycleRead, id pgtype.UUID, revision int64) (db.CockpitMeetingAgenda, error) {
	a, e := q.GetCockpitMeetingAgenda(ctx, db.GetCockpitMeetingAgendaParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: id})
	if e != nil {
		return a, cockpitWorkflowError(e)
	}
	if a.RemovedAt.Valid || a.Revision != revision {
		return a, ErrCockpitWorkflowConflict
	}
	return a, nil
}

func (s *IssueService) GetCockpitMeetingLifecycleCommand(ctx context.Context, p CockpitLifecycleRead, key pgtype.UUID) (CockpitLifecycleCommandDetail, error) {
	tx, q, _, e := s.beginLifecycleRead(ctx, p)
	if e != nil {
		return CockpitLifecycleCommandDetail{}, e
	}
	defer tx.Rollback(ctx)
	c, e := q.GetCockpitLifecycleCommand(ctx, db.GetCockpitLifecycleCommandParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, CommandKey: key})
	if e != nil {
		return CockpitLifecycleCommandDetail{}, cockpitWorkflowError(e)
	}
	out := CockpitLifecycleCommandDetail{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), CockpitLifecycleCommandMetadata: CockpitLifecycleCommandMetadata{CommandKey: util.UUIDToString(c.CommandKey), Action: c.Kind, ActorType: c.ActorType, DirectoryOperationID: planningUUID(c.DirectoryOperationID), DirectoryStepID: planningUUID(c.DirectoryStepID), ActorID: util.UUIDToString(c.ActorID), CreatedAt: c.CreatedAt.Time.UTC().Format(time.RFC3339Nano), Revision: c.Revision, AgendaID: planningUUID(c.AgendaID), ReferenceID: planningUUID(c.ReferenceID), IssueID: planningUUID(c.IssueID), OperationID: planningUUID(c.OperationID), EffectID: planningUUID(c.EffectID)}}
	if c.ActorType == "agent" {
		agent, err := q.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: c.ActorID})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return out, err
		}
		if err == nil {
			out.ActorName = agent.Name
		}
	} else {
		users, err := q.GetUsersByIDs(ctx, []pgtype.UUID{c.ActorID})
		if err != nil {
			return out, err
		}
		if len(users) > 0 {
			out.ActorName = users[0].Name
		}
	}
	e = json.Unmarshal(c.Receipt, &out.Receipt)
	return out, e
}
