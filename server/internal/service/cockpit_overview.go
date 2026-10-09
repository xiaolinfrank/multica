package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type overviewCursor struct {
	Scope string `json:"scope"`
	Key   string `json:"key"`
}

func overviewCursorScope(p CockpitOverviewQuery, section string, size int32) string {
	if section == "execution" || section == "meetings" {
		p.View, p.Kind = "mine", ""
	}
	return planningHash(struct {
		Workspace, Project, Actor pgtype.UUID
		Human                     bool
		AsOf, View, Kind, Section string
		Size, Days                int32
	}{
		p.WorkspaceID, p.ProjectID, p.ActorID, p.Human, p.AsOf, p.View, p.Kind, section, size, p.Days})
}
func readOverviewCursor(value, scope string) (string, error) {
	if value == "" {
		return "", nil
	}
	if len(value) > 4096 {
		return "", fmt.Errorf("%w: cursor exceeds supported length", ErrCockpitWorkflowInput)
	}
	b, err := base64.RawURLEncoding.DecodeString(value)
	var c overviewCursor
	if err != nil || json.Unmarshal(b, &c) != nil || c.Scope != scope || c.Key == "" || len(c.Key) > 200 {
		return "", fmt.Errorf("%w: cursor does not match this dashboard scope and filter", ErrCockpitWorkflowInput)
	}
	return c.Key, nil
}
func makeOverviewCursor(scope, key string) *string {
	b, _ := json.Marshal(overviewCursor{scope, key})
	value := base64.RawURLEncoding.EncodeToString(b)
	return &value
}
func normalizeOverviewQuery(p CockpitOverviewQuery) (CockpitOverviewQuery, time.Time, error) {
	date, err := time.Parse("2006-01-02", p.AsOf)
	if err != nil {
		return p, date, fmt.Errorf("%w: as_of must be a calendar date (YYYY-MM-DD)", ErrCockpitWorkflowInput)
	}
	if p.View == "" {
		p.View = "mine"
	}
	if p.View != "mine" && p.View != "team" {
		return p, date, fmt.Errorf("%w: view must be mine or team", ErrCockpitWorkflowInput)
	}
	switch p.Kind {
	case "", "workflow", "action", "nas", "issue":
	default:
		return p, date, fmt.Errorf("%w: unsupported attention kind", ErrCockpitWorkflowInput)
	}
	if p.Days == 0 {
		p.Days = 30
	}
	if p.Days < 1 || p.Days > 90 {
		return p, date, fmt.Errorf("%w: days must be 1–90", ErrCockpitWorkflowInput)
	}
	p.PageSize, err = planningPageSize(p.PageSize)
	return p, date, err
}

// Each call has one read-only, repeatable-read snapshot. No first-read board
// creation, mutable status repair, filesystem probes, or task dispatch occurs.
func (s *IssueService) readCockpitOverview(ctx context.Context, p CockpitOverviewQuery, section string) (CockpitOverview, error) {
	var out CockpitOverview
	p, date, err := normalizeOverviewQuery(p)
	if err != nil {
		return out, err
	}
	key, err := readOverviewCursor(p.Cursor, overviewCursorScope(p, section, p.PageSize))
	if err != nil {
		return out, err
	}
	if section == "overview" && p.Cursor != "" {
		return out, fmt.Errorf("%w: use a section endpoint to continue its cursor", ErrCockpitWorkflowInput)
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	member, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: p.ActorID, WorkspaceID: p.WorkspaceID})
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrCockpitWorkflowNotFound
	}
	if err != nil {
		return out, err
	}
	out.CockpitOverviewScope = CockpitOverviewScope{WorkspaceID: util.UUIDToString(p.WorkspaceID), ProjectID: planningUUID(p.ProjectID), AsOf: p.AsOf, GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if p.ProjectID.Valid {
		project, err := q.GetCockpitOverviewProject(ctx, db.GetCockpitOverviewProjectParams{WorkspaceID: p.WorkspaceID, ID: p.ProjectID})
		if err != nil {
			return out, planningError(err)
		}
		out.ProjectTitle = project.Title
	}
	out.Actor = CockpitOverviewActor{UserID: util.UUIDToString(member.UserID), Role: member.Role, IsHuman: p.Human}
	if section == "overview" {
		board, err := q.GetCockpitOverviewBoard(ctx, p.WorkspaceID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return out, err
		}
		if err == nil {
			var goalDate *string
			if board.GoalDate.Valid {
				value := board.GoalDate.Time.Format("2006-01-02")
				goalDate = &value
			}
			out.Board = &CockpitOverviewBoard{ID: util.UUIDToString(board.ID), Title: board.Title, GoalTitle: board.GoalTitle, GoalDate: goalDate}
		}
	}
	payload, err := q.GetCockpitOverviewReadModel(ctx, db.GetCockpitOverviewReadModelParams{
		WorkspaceID: p.WorkspaceID, ProjectID: p.ProjectID, ActorID: p.ActorID, Human: p.Human, ActorRole: member.Role,
		AsOf: pgtype.Date{Time: date, Valid: true}, View: p.View, Kind: p.Kind, Section: section, CursorKey: key, PageSize: p.PageSize, Days: p.Days,
	})
	if err != nil {
		return out, err
	}
	var raw struct {
		Summary   CockpitOverviewSummary `json:"summary"`
		Attention struct {
			Items []struct {
				CockpitAttentionItem
				SortKey string `json:"sort_key"`
			} `json:"items"`
			Total int64 `json:"total"`
		} `json:"attention"`
		ExecutionNodes CockpitExecutionOverviewPage `json:"execution_nodes"`
		RecentMeetings CockpitRecentMeetingPage     `json:"recent_meetings"`
	}
	if err = json.Unmarshal(payload, &raw); err != nil {
		return out, fmt.Errorf("decode cockpit overview read model: %w", err)
	}
	out.Summary = raw.Summary
	attentionSize, executionSize, meetingSize := p.PageSize, p.PageSize, p.PageSize
	if section == "overview" {
		attentionSize, executionSize, meetingSize = 8, 6, 6
	}
	out.Attention = CockpitAttentionPage{CockpitOverviewScope: out.CockpitOverviewScope, View: p.View, Kind: p.Kind, Items: []CockpitAttentionItem{}, Total: raw.Attention.Total}
	if len(raw.Attention.Items) > int(attentionSize) {
		raw.Attention.Items = raw.Attention.Items[:attentionSize]
		out.Attention.NextCursor = makeOverviewCursor(overviewCursorScope(p, "attention", attentionSize), raw.Attention.Items[len(raw.Attention.Items)-1].SortKey)
	}
	for _, item := range raw.Attention.Items {
		out.Attention.Items = append(out.Attention.Items, item.CockpitAttentionItem)
	}
	out.ExecutionNodes = raw.ExecutionNodes
	out.ExecutionNodes.CockpitOverviewScope = out.CockpitOverviewScope
	if len(out.ExecutionNodes.Items) > int(executionSize) {
		out.ExecutionNodes.Items = out.ExecutionNodes.Items[:executionSize]
		out.ExecutionNodes.NextCursor = makeOverviewCursor(overviewCursorScope(p, "execution", executionSize), out.ExecutionNodes.Items[len(out.ExecutionNodes.Items)-1].ID)
	}
	out.RecentMeetings = raw.RecentMeetings
	out.RecentMeetings.CockpitOverviewScope = out.CockpitOverviewScope
	out.RecentMeetings.RangeStart = date.AddDate(0, 0, -int(p.Days)+1).Format("2006-01-02")
	out.RecentMeetings.RangeEnd = date.AddDate(0, 0, 7).Format("2006-01-02")
	if len(out.RecentMeetings.Items) > int(meetingSize) {
		out.RecentMeetings.Items = out.RecentMeetings.Items[:meetingSize]
		item := out.RecentMeetings.Items[len(out.RecentMeetings.Items)-1]
		out.RecentMeetings.NextCursor = makeOverviewCursor(overviewCursorScope(p, "meetings", meetingSize), item.MeetDate+":"+item.ID)
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	return out, nil
}
func (s *IssueService) GetCockpitOverview(ctx context.Context, p CockpitOverviewQuery) (CockpitOverview, error) {
	return s.readCockpitOverview(ctx, p, "overview")
}
func (s *IssueService) ListCockpitOverviewAttention(ctx context.Context, p CockpitOverviewQuery) (CockpitAttentionPage, error) {
	out, err := s.readCockpitOverview(ctx, p, "attention")
	return out.Attention, err
}
func (s *IssueService) ListCockpitOverviewExecution(ctx context.Context, p CockpitOverviewQuery) (CockpitExecutionOverviewPage, error) {
	out, err := s.readCockpitOverview(ctx, p, "execution")
	return out.ExecutionNodes, err
}
func (s *IssueService) ListCockpitOverviewMeetings(ctx context.Context, p CockpitOverviewQuery) (CockpitRecentMeetingPage, error) {
	out, err := s.readCockpitOverview(ctx, p, "meetings")
	return out.RecentMeetings, err
}
