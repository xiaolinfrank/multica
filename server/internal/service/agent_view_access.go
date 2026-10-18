package service

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func memberMayViewAgentFacts(owner, actor pgtype.UUID, role, permissionMode string, targetMatches bool) bool {
	return owner == actor || role == "owner" || role == "admin" || (permissionMode == "public_to" && targetMatches)
}

// MemberMayViewAgent is the existing inventory/task-cancel policy, not INVOKE.
// Workspace administrators retain its governance access; using an agent's
// credentials still requires the separate invocation policy.
func MemberMayViewAgent(ctx context.Context, q *db.Queries, agent db.Agent, actor, workspace pgtype.UUID) (bool, error) {
	if actor == agent.OwnerID {
		return true, nil
	}
	m, e := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{WorkspaceID: workspace, UserID: actor})
	if errors.Is(e, pgx.ErrNoRows) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	if memberMayViewAgentFacts(agent.OwnerID, actor, m.Role, agent.PermissionMode, false) {
		return true, nil
	}
	if agent.PermissionMode != "public_to" {
		return false, nil
	}
	targets, e := q.ListAgentInvocationTargets(ctx, agent.ID)
	if e != nil {
		return false, e
	}
	for _, target := range targets {
		if target.TargetType == "workspace" || (target.TargetType == "member" && target.TargetID == actor) {
			return memberMayViewAgentFacts(agent.OwnerID, actor, m.Role, agent.PermissionMode, true), nil
		}
	}
	return false, nil
}
