package service

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type dispositionIssueFacts struct {
	View       CockpitDispositionIssue
	Automation db.ReadCockpitDispositionAutomationFactsRow
}

func readDispositionIssues(ctx context.Context, q *db.Queries, p CockpitLifecycleRead, ids []pgtype.UUID, excluded ...[]pgtype.UUID) (map[pgtype.UUID]dispositionIssueFacts, error) {
	out := map[pgtype.UUID]dispositionIssueFacts{}
	if len(ids) == 0 {
		return out, nil
	}
	issues, e := readPlanningIssueFacts(ctx, q, p.WorkspaceID, ids)
	if e != nil {
		return nil, e
	}
	payload, e := q.ReadIssueOperationBasisFacts(ctx, db.ReadIssueOperationBasisFactsParams{WorkspaceID: p.WorkspaceID, IssueIds: ids})
	if e != nil {
		return nil, e
	}
	var facts []issueOperationFacts
	if e = json.Unmarshal(payload, &facts); e != nil {
		return nil, e
	}
	basis := map[string]IssueOperationBasis{}
	for _, f := range facts {
		basis[f.ID] = projectIssueOperationBasis(f, p.Human)
	}
	var excludedRunIDs []pgtype.UUID
	if len(excluded) > 0 {
		excludedRunIDs = excluded[0]
	}
	automation, e := q.ReadCockpitDispositionAutomationFacts(ctx, db.ReadCockpitDispositionAutomationFactsParams{WorkspaceID: p.WorkspaceID, IssueIds: ids, ExcludedRunIds: excludedRunIDs})
	if e != nil {
		return nil, e
	}
	closed, e := issuestatus.Resolve(ctx, q, p.WorkspaceID, "cancelled")
	if e != nil && !errors.Is(e, issuestatus.ErrUnknownStatus) {
		return nil, e
	}
	closedValid := e == nil && closed.Category == "closed"
	for _, a := range automation {
		issue, ok := issues[a.ID]
		if !ok {
			continue
		}
		b, ok := basis[util.UUIDToString(a.ID)]
		if !ok || b.IssueRevision == nil {
			continue
		}
		v := CockpitDispositionIssue{Issue: issue, IssueRevision: *b.IssueRevision, CanCancel: p.Human && closedValid && b.Status.State == "allowed" && slices.Contains(b.Status.AllowedCategories, "closed") && !a.IsMinutesReview && !slices.Contains(b.Status.ReasonCodes, "formal_review_status"),
			CanChangeDueDate: p.Human, CanLinkMeeting: p.Human, BlockedReasons: []string{}, OrdinaryWakeupCount: a.OrdinaryWakeupCount, SystemRuleCount: a.SystemRuleCount, UnstartedWakeupRunCount: a.UnstartedWakeupRunCount, OtherQueuedRunCount: a.OtherQueuedRunCount, ActiveRunCount: a.ActiveRunCount, Targets: b.Targets, TargetsTotal: b.TargetsTotal, ParentIssueID: planningUUID(a.ParentIssueID), EvaluatesParentRules: a.ParentIssueID.Valid}
		if closedValid {
			key := closed.Key
			v.CancelStatus = &key
		} else {
			v.BlockedReasons = append(v.BlockedReasons, "closed_status_unavailable")
		}
		if a.IsMinutesReview {
			v.BlockedReasons = append(v.BlockedReasons, "formal_review_required")
		}
		if !slices.Contains(b.Status.AllowedCategories, "closed") {
			v.BlockedReasons = append(v.BlockedReasons, "formal_review_required")
		}
		if !p.Human {
			v.BlockedReasons = append(v.BlockedReasons, "human_required")
		}
		out[a.ID] = dispositionIssueFacts{View: v, Automation: a}
	}
	return out, nil
}

func (s *IssueService) ListCockpitCancellationImpact(ctx context.Context, p CockpitPreparationQuery) (CockpitCancellationImpactPage, error) {
	var out CockpitCancellationImpactPage
	p.Query = strings.TrimSpace(p.Query)
	if len(p.Query) > 512 {
		return out, ErrCockpitWorkflowInput
	}
	size, e := planningPageSize(p.PageSize)
	if e != nil {
		return out, e
	}
	scope := planningHash([]any{"meeting_cancellation_impact", p.WorkspaceID, p.MeetingID, p.Query, size})
	_, id, e := decodeLifecycleCursor(p.Cursor, scope, 0)
	if e != nil {
		return out, e
	}
	tx, q, x, e := s.beginLifecycleRead(ctx, p.CockpitLifecycleRead)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	total, e := q.CountCockpitDispositionIssues(ctx, db.CountCockpitDispositionIssuesParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, Query: p.Query})
	if e != nil {
		return out, e
	}
	ids, e := q.ListCockpitDispositionIssueIDs(ctx, db.ListCockpitDispositionIssueIDsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, Query: p.Query, AfterID: id, PageLimit: size + 1})
	if e != nil {
		return out, e
	}
	out = CockpitCancellationImpactPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), LifecycleRevision: x.meeting.LifecycleRevision, Query: p.Query, PageSize: size, Items: []CockpitDispositionIssue{}, Total: total}
	if len(ids) > int(size) {
		ids = ids[:size]
		out.NextCursor = encodeLifecycleCursor(lifecycleCursor{Scope: scope, ID: util.UUIDToString(ids[len(ids)-1])})
	}
	facts, e := readDispositionIssues(ctx, q, p.CockpitLifecycleRead, ids)
	if e != nil {
		return out, e
	}
	for _, id := range ids {
		if f, ok := facts[id]; ok {
			out.Items = append(out.Items, f.View)
		} else {
			return out, ErrCockpitWorkflowConflict
		}
	}
	return out, nil
}

func (s *IssueService) ListCockpitDispositionRuns(ctx context.Context, p CockpitPreparationQuery) (CockpitDispositionRunPage, error) {
	var out CockpitDispositionRunPage
	size, e := planningPageSize(p.PageSize)
	if e != nil {
		return out, e
	}
	scope := planningHash([]any{"meeting_disposition_runs", p.WorkspaceID, p.MeetingID, p.IssueID, p.ActorID, size})
	_, id, e := decodeLifecycleCursor(p.Cursor, scope, 0)
	if e != nil {
		return out, e
	}
	tx, q, _, e := s.beginLifecycleRead(ctx, p.CockpitLifecycleRead)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	found, e := q.CockpitMeetingHasPreparationIssue(ctx, db.CockpitMeetingHasPreparationIssueParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, IssueID: p.IssueID})
	if e != nil {
		return out, e
	}
	if !found {
		return out, ErrCockpitWorkflowNotFound
	}
	role, e := preparationRole(ctx, q, p.CockpitLifecycleRead)
	if e != nil {
		return out, e
	}
	total, e := q.CountCockpitDispositionRuns(ctx, db.CountCockpitDispositionRunsParams{WorkspaceID: p.WorkspaceID, IssueID: p.IssueID})
	if e != nil {
		return out, e
	}
	rows, e := q.ListCockpitDispositionRuns(ctx, db.ListCockpitDispositionRunsParams{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID, IssueID: p.IssueID, AfterID: id, PageLimit: size + 1})
	if e != nil {
		return out, e
	}
	out = CockpitDispositionRunPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), IssueID: util.UUIDToString(p.IssueID), PageSize: size, Items: []CockpitDispositionRun{}, Total: total}
	if len(rows) > int(size) {
		rows = rows[:size]
		out.NextCursor = encodeLifecycleCursor(lifecycleCursor{Scope: scope, ID: util.UUIDToString(rows[len(rows)-1].ID)})
	}
	for _, r := range rows {
		allowed := r.PermissionMode.Valid && memberMayViewAgentFacts(r.OwnerID, p.ActorID, role, r.PermissionMode.String, r.TargetMatches)
		item := CockpitDispositionRun{ID: util.UUIDToString(r.ID), IssueID: out.IssueID, AgentID: util.UUIDToString(r.AgentID), Status: r.Status, StartedAt: lifecycleTime(r.StartedAt), IsWakeup: r.IsWakeup, CanStop: p.Human && allowed, BlockedReasons: []string{}}
		if allowed {
			item.AgentName = r.AgentName
		} else {
			item.BlockedReasons = append(item.BlockedReasons, "task_not_accessible")
		}
		if !p.Human {
			item.BlockedReasons = append(item.BlockedReasons, "human_required")
		}
		out.Items = append(out.Items, item)
	}
	return out, nil
}
