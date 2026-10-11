package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/pkg/protocol"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type CockpitIssueNodeReference struct {
	NodeID    string `json:"node_id"`
	Code      string `json:"code"`
	Title     string `json:"title"`
	Available bool   `json:"available"`
	Relation  string `json:"relation"`
	CanUnlink bool   `json:"can_unlink"`
}
type CockpitIssueMeetingReference struct {
	ArchivedAt         *string  `json:"archived_at"`
	HasDirectReference bool     `json:"has_direct_reference"`
	HasAgendaReference bool     `json:"has_agenda_reference"`
	AgendaID           *string  `json:"agenda_id"`
	AgendaTotal        int64    `json:"agenda_total"`
	MeetingID          string   `json:"meeting_id"`
	Code               string   `json:"code"`
	Title              string   `json:"title"`
	MeetDate           string   `json:"meet_date"`
	Available          bool     `json:"available"`
	Role               string   `json:"role"`
	Roles              []string `json:"roles"`
	RequiredRoles      []string `json:"required_roles"`
	CanUnlink          bool     `json:"can_unlink"`
}
type CockpitIssueReferencePage[T any] struct {
	WorkspaceID string  `json:"workspace_id"`
	IssueID     string  `json:"issue_id"`
	Items       []T     `json:"items"`
	Total       int64   `json:"total"`
	NextCursor  *string `json:"next_cursor"`
}

func readCockpitIssueReferences[T any](ctx context.Context, s *IssueService, workspace, issue pgtype.UUID, kind, cursor string, pageSize int32, idOf func(T) string) (CockpitIssueReferencePage[T], error) {
	out := CockpitIssueReferencePage[T]{WorkspaceID: util.UUIDToString(workspace), IssueID: util.UUIDToString(issue), Items: []T{}}
	size, err := planningPageSize(pageSize)
	if err != nil {
		return out, err
	}
	if len(cursor) > 4096 {
		return out, fmt.Errorf("%w: cursor is too long", ErrCockpitWorkflowInput)
	}
	scope := planningHash([]any{"issue_references", workspace, issue, kind, size})
	last, _, err := decodePlanningCursor(cursor, scope)
	if err != nil {
		return out, err
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err = q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: workspace, ID: issue}); err != nil {
		return out, planningError(err)
	}
	payload, err := q.ReadCockpitIssueReferences(ctx, db.ReadCockpitIssueReferencesParams{WorkspaceID: workspace, IssueID: issue, Kind: kind, CursorID: last, PageSize: size})
	if err != nil {
		return out, err
	}
	if err = json.Unmarshal(payload, &out); err != nil {
		return out, err
	}
	if len(out.Items) > int(size) {
		out.Items = out.Items[:size]
		id, parseErr := util.ParseUUID(idOf(out.Items[len(out.Items)-1]))
		if parseErr != nil {
			return out, parseErr
		}
		out.NextCursor = encodePlanningCursor(scope, id, 0)
	}
	return out, nil
}
func (s *IssueService) ListCockpitIssueNodeReferences(ctx context.Context, workspace, issue pgtype.UUID, cursor string, size int32) (CockpitIssueReferencePage[CockpitIssueNodeReference], error) {
	return readCockpitIssueReferences(ctx, s, workspace, issue, "nodes", cursor, size, func(v CockpitIssueNodeReference) string { return v.NodeID })
}
func (s *IssueService) ListCockpitIssueMeetingReferences(ctx context.Context, workspace, issue pgtype.UUID, cursor string, size int32) (CockpitIssueReferencePage[CockpitIssueMeetingReference], error) {
	return readCockpitIssueReferences(ctx, s, workspace, issue, "meetings", cursor, size, func(v CockpitIssueMeetingReference) string { return v.MeetingID })
}

type CockpitIssueReferenceRemoval struct {
	WorkspaceID string `json:"workspace_id"`
	IssueID     string `json:"issue_id"`
	Kind        string `json:"kind"`
	TargetID    string `json:"target_id"`
	Removed     bool   `json:"removed"`
}

// Remove one explicit reference using the accessible Issue as its authority.
// Missing target records do not require creating a board or guessing an owner.
func (s *IssueService) RemoveCockpitIssueReference(ctx context.Context, workspace, issue, target, actor pgtype.UUID, kind string) (CockpitIssueReferenceRemoval, error) {
	out := CockpitIssueReferenceRemoval{WorkspaceID: util.UUIDToString(workspace), IssueID: util.UUIDToString(issue), Kind: kind, TargetID: util.UUIDToString(target)}
	if kind != "node" && kind != "meeting" {
		return out, ErrCockpitWorkflowInput
	}
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	q := s.Queries.WithTx(tx)
	if err = cockpitWorkflowMember(ctx, q, workspace, actor); err != nil {
		return out, err
	}
	if _, err = q.LockWorkspaceForChatSessionCreate(ctx, workspace); err != nil {
		return out, planningError(err)
	}
	if _, err = q.LockCockpitForWorkspaceChanges(ctx, workspace); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	if kind == "meeting" {
		if _, err = q.LockCockpitMeetingForWork(ctx, db.LockCockpitMeetingForWorkParams{WorkspaceID: workspace, ID: target}); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return out, err
		}
	}
	if _, err = q.LockIssueForDelete(ctx, db.LockIssueForDeleteParams{WorkspaceID: workspace, ID: issue}); err != nil {
		return out, planningError(err)
	}
	scope := "issue_links"
	entity := map[string]any{"issue_id": out.IssueID, "node_id": out.TargetID}
	if kind == "node" {
		if _, err = q.LockCockpitIssueNodeReference(ctx, db.LockCockpitIssueNodeReferenceParams{WorkspaceID: workspace, IssueID: issue, NodeID: target}); err != nil {
			return out, planningError(err)
		}
		err = q.DeleteCockpitNodeIssue(ctx, db.DeleteCockpitNodeIssueParams{WorkspaceID: workspace, IssueID: issue, NodeID: target})
	} else {
		if _, err = q.LockCockpitIssueMeetingReference(ctx, db.LockCockpitIssueMeetingReferenceParams{WorkspaceID: workspace, IssueID: issue, MeetingID: target}); err != nil {
			return out, planningError(err)
		}
		role, e := q.CockpitMeetingWorkflowRequiredRole(ctx, db.CockpitMeetingWorkflowRequiredRoleParams{WorkspaceID: workspace, IssueID: issue, MeetingID: target})
		if e != nil {
			return out, e
		}
		if role != "" {
			return out, fmt.Errorf("%w: formal work package references must be preserved", ErrCockpitWorkflowConflict)
		}
		err = q.DeleteCockpitMeetingIssue(ctx, db.DeleteCockpitMeetingIssueParams{WorkspaceID: workspace, IssueID: issue, MeetingID: target})
		scope = "meeting_issues"
		entity = map[string]any{"issue_id": out.IssueID, "meeting_id": out.TargetID}
	}
	if err != nil {
		return out, err
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	out.Removed = true
	if s.Bus != nil {
		s.Bus.Publish(events.Event{Type: protocol.EventCockpitChanged, WorkspaceID: out.WorkspaceID, ActorType: "member", ActorID: util.UUIDToString(actor), Payload: map[string]any{"scope": scope, "action": "removed", "entity": entity}})
	}
	return out, nil
}
