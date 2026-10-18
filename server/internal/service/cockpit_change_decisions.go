package service

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// NoteCockpitChangeDecision leaves the review outcome on the issue of the task
// that filed the proposal. A proposal is a request a task is waiting on: when
// the queue decides it and nothing tells the task, the requesting run either
// polls the cockpit forever or assumes the silence means rejection — the same
// gap the runtime-unusable notice exists to close.
//
// Best-effort, exactly like that notice: the decision is correct whether or
// not the comment lands, so a failure here is logged rather than returned.
// Hand-filed proposals (no source task) and tasks whose issue is gone simply
// have no one to notify.
func (s *IssueService) NoteCockpitChangeDecision(ctx context.Context, change db.CockpitPendingChange) {
	if !change.SourceTaskID.Valid {
		return
	}
	task, err := s.Queries.GetAgentTask(ctx, change.SourceTaskID)
	if err != nil {
		slog.Warn("cockpit change decision note: source task gone", "change_id", util.UUIDToString(change.ID), "error", err)
		return
	}
	issue, err := s.Queries.GetIssue(ctx, task.IssueID)
	if err != nil {
		slog.Warn("cockpit change decision note: source issue gone", "change_id", util.UUIDToString(change.ID), "error", err)
		return
	}
	created, err := s.Queries.CreateComment(ctx, db.CreateCommentParams{
		ID:          dbid.NewV7(),
		IssueID:     issue.ID,
		WorkspaceID: issue.WorkspaceID,
		AuthorType:  "system",
		AuthorID:    pgtype.UUID{Valid: true},
		Content:     CockpitChangeDecisionNotice(change),
		Type:        "system",
		ParentID:    pgtype.UUID{Valid: false},
	})
	if err != nil {
		slog.Warn("cockpit change decision note: create system comment failed",
			"error", err, "issue_id", util.UUIDToString(issue.ID))
		return
	}
	comment := created.Comment()
	if s.Bus == nil {
		return
	}
	s.Bus.Publish(events.Event{
		Type:        protocol.EventCommentCreated,
		WorkspaceID: util.UUIDToString(issue.WorkspaceID),
		ActorType:   "system",
		Payload: map[string]any{
			"comment": map[string]any{
				"id":          util.UUIDToString(comment.ID),
				"issue_id":    util.UUIDToString(comment.IssueID),
				"author_type": comment.AuthorType,
				"author_id":   util.UUIDToString(comment.AuthorID),
				"content":     comment.Content,
				"parent_id":   util.UUIDToString(comment.ParentID),
				"type":        comment.Type,
				"created_at":  comment.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
			},
		},
	})
}

// CockpitChangeDecisionNotice renders the fixed system text for a decision.
// Kept as a function so tests can assert the exact wording the requesting
// task will read.
func CockpitChangeDecisionNotice(change db.CockpitPendingChange) string {
	switch change.Status {
	case "applied":
		return fmt.Sprintf("Plan update accepted: the reviewed proposal for cockpit field %q now stands at %q (it read %q when the review confirmed it).",
			change.Field, change.NewValue, change.OldValue)
	case "rejected":
		note := ""
		if strings.TrimSpace(change.DecisionNote) != "" {
			note = " Reason: " + strings.TrimSpace(change.DecisionNote)
		}
		return fmt.Sprintf("Plan update rejected: the proposed change to cockpit field %q (%q → %q) was reviewed and not accepted. The cockpit keeps its current value.%s",
			change.Field, change.OldValue, change.NewValue, note)
	default:
		return fmt.Sprintf("Plan update closed (%s): the proposal for cockpit field %q is no longer pending.", change.Status, change.Field)
	}
}
