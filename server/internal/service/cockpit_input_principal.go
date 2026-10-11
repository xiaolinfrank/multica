package service

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type cockpitInputAuthority struct {
	Principal CockpitInputPrincipal
	Member    db.Member
	Run       db.AgentTaskQueue
}

func inputMembership(ctx context.Context, q *db.Queries, p CockpitInputRead) (db.Member, error) {
	if !p.WorkspaceID.Valid || !p.CredentialOwnerID.Valid {
		return db.Member{}, inputError("permission_revoked", "A current workspace principal is required.")
	}
	member, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{WorkspaceID: p.WorkspaceID, UserID: p.CredentialOwnerID})
	if errors.Is(err, pgx.ErrNoRows) {
		return member, inputError("permission_revoked", "The credential owner is no longer a workspace member.")
	}
	return member, err
}

// New uploads and registrations require a live task-specific delegation. Reads
// may use a valid terminal task token for its retained fixed pin, but never to
// manufacture a new grant. Daemon claims are accepted only by the read path.
func inputNewPrincipal(ctx context.Context, q *db.Queries, p CockpitInputRead, lock bool) (cockpitInputAuthority, error) {
	return inputPrincipal(ctx, q, p, lock, true)
}
func inputReadPrincipal(ctx context.Context, q *db.Queries, p CockpitInputRead) (cockpitInputAuthority, error) {
	return inputPrincipal(ctx, q, p, false, false)
}
func inputPrincipal(ctx context.Context, q *db.Queries, p CockpitInputRead, lock, newCommand bool) (cockpitInputAuthority, error) {
	return inputPrincipalWithGrant(ctx, q, p, lock, newCommand, false)
}

// acceptedGrant is used only for a persisted transfer read from this workspace.
// It preserves its real source principal after token expiry or Run completion;
// membership, originator, runtime and current INVOKE remain authoritative.
func inputPrincipalWithGrant(ctx context.Context, q *db.Queries, p CockpitInputRead, lock, newCommand, acceptedGrant bool) (cockpitInputAuthority, error) {
	var a cockpitInputAuthority
	member, err := inputMembership(ctx, q, p)
	if err != nil {
		return a, err
	}
	a.Member = member
	user := util.UUIDToString(p.CredentialOwnerID)
	if p.ActorSource == "human" {
		u, err := q.GetUser(ctx, p.CredentialOwnerID)
		if err != nil {
			return a, err
		}
		a.Principal = CockpitInputPrincipal{ActorType: "member", ActorID: user, ActorName: u.Name, CredentialOwnerUserID: user, AuthorizingUserID: user, AuthorizingUserName: u.Name}
		return a, nil
	}
	if p.ActorSource != "task_token" && (newCommand || p.ActorSource != "daemon_claim") {
		return a, inputError("task_context_required", "This input operation requires a human or a precise authorized task.")
	}
	if !p.RunID.Valid || !p.AgentID.Valid {
		return a, inputError("task_context_required", "The authenticated task identity is incomplete.")
	}
	if p.ActorSource == "task_token" && !acceptedGrant {
		if !p.TaskTokenID.Valid {
			return a, inputError("task_context_required", "A verified task token is required.")
		}
		token, e := q.ReadLiveCockpitDirectoryTaskToken(ctx, db.ReadLiveCockpitDirectoryTaskTokenParams{WorkspaceID: p.WorkspaceID, ID: p.TaskTokenID})
		if errors.Is(e, pgx.ErrNoRows) {
			return a, inputError("source_run_unavailable", "The task credential is no longer valid.")
		}
		if e != nil {
			return a, e
		}
		if token.TaskID != p.RunID || token.AgentID != p.AgentID || token.UserID != p.CredentialOwnerID {
			return a, inputError("task_context_required", "The credential does not match this precise task principal.")
		}
	}
	run, err := q.GetAgentTaskInWorkspace(ctx, db.GetAgentTaskInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: p.RunID})
	if errors.Is(err, pgx.ErrNoRows) {
		return a, inputError("source_run_unavailable", "The authenticated task is unavailable.")
	}
	if err != nil {
		return a, err
	}
	if run.AgentID != p.AgentID || !run.IssueID.Valid || run.ChatSessionID.Valid || !run.RuntimeID.Valid || !run.OriginatorUserID.Valid {
		return a, inputError("delegation_unavailable", "An exact Issue-backed task originator is required.")
	}
	originator, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{WorkspaceID: p.WorkspaceID, UserID: run.OriginatorUserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return a, inputError("permission_revoked", "The authorizing member is no longer in this workspace.")
	}
	if err != nil {
		return a, err
	}
	_ = originator
	if _, err = q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: run.IssueID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return a, inputError("delegation_unavailable", "The precise source Issue is unavailable.")
		}
		return a, err
	}
	var runtime db.AgentRuntime
	var agent db.Agent
	if lock {
		if _, err = q.LockCockpitCreationMember(ctx, db.LockCockpitCreationMemberParams{WorkspaceID: p.WorkspaceID, UserID: run.OriginatorUserID}); err != nil {
			return a, inputError("permission_revoked", "The authorizing member is unavailable.")
		}
		runtime, err = q.LockCockpitInputRuntimeAuthority(ctx, run.RuntimeID)
		if err != nil {
			return a, err
		}
		agent, err = q.LockCockpitInputAgentAuthority(ctx, p.AgentID)
		if err != nil {
			return a, err
		}
		latest, e := q.LockCockpitDirectoryRun(ctx, db.LockCockpitDirectoryRunParams{WorkspaceID: p.WorkspaceID, ID: p.RunID})
		if e != nil {
			return a, e
		}
		if latest.OriginatorUserID != run.OriginatorUserID || latest.RuntimeID != run.RuntimeID || latest.IssueID != run.IssueID {
			return a, inputError("source_run_unavailable", "The task delegation changed during authorization.")
		}
		run = latest
		if p.ActorSource == "task_token" && !acceptedGrant {
			token, e := q.GetLiveCockpitDirectoryTaskToken(ctx, db.GetLiveCockpitDirectoryTaskTokenParams{WorkspaceID: p.WorkspaceID, ID: p.TaskTokenID})
			if e != nil {
				return a, inputError("source_run_unavailable", "The task credential is unavailable.")
			}
			if token.TaskID != run.ID || token.AgentID != p.AgentID || token.UserID != p.CredentialOwnerID {
				return a, inputError("task_context_required", "The task credential changed during authorization.")
			}
		}
	} else {
		runtime, err = q.GetAgentRuntime(ctx, run.RuntimeID)
		if err != nil {
			return a, err
		}
		agent, err = q.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: p.AgentID})
		if err != nil {
			return a, err
		}
	}
	live := run.Status == "dispatched" || run.Status == "running"
	if newCommand && !live {
		return a, inputError("source_run_unavailable", "A new input command requires a currently active authorized Run.")
	}
	if !newCommand && !live && run.Status != "completed" && run.Status != "failed" && run.Status != "cancelled" && run.Status != "waiting_local_directory" {
		return a, inputError("source_run_unavailable", "This task does not have a supported input-read state.")
	}
	if agent.WorkspaceID != p.WorkspaceID || runtime.WorkspaceID != p.WorkspaceID || runtime.OwnerID != p.CredentialOwnerID || agent.RuntimeID != run.RuntimeID || !cockpitAssignableAgentStatus(agent.Status) || (runtime.Visibility == "private" && runtime.OwnerID != agent.OwnerID) {
		return a, inputError("permission_revoked", "The Agent and runtime no longer authorize this exact task principal.")
	}
	if p.ActorSource == "daemon_claim" && ((p.TrustedDaemonID != "" && (!runtime.DaemonID.Valid || runtime.DaemonID.String != p.TrustedDaemonID)) || p.RuntimeID != run.RuntimeID || !p.ClaimDispatchedAt.Valid || !run.DispatchedAt.Valid || !p.ClaimDispatchedAt.Time.Equal(run.DispatchedAt.Time) || (!live && run.Status != "waiting_local_directory")) {
		return a, inputError("permission_revoked", "This runtime no longer owns the exact dispatched claim.")
	}
	allowed, err := memberMayInvokeAgent(ctx, q, agent, run.OriginatorUserID, p.WorkspaceID)
	if err != nil {
		return a, err
	}
	if !allowed {
		return a, inputError("permission_revoked", "The task originator can no longer invoke this Agent.")
	}
	u, err := q.GetUser(ctx, run.OriginatorUserID)
	if err != nil {
		return a, err
	}
	a.Run = run
	a.Principal = CockpitInputPrincipal{ActorType: "agent", ActorID: util.UUIDToString(agent.ID), ActorName: agent.Name, CredentialOwnerUserID: user, AuthorizingUserID: util.UUIDToString(run.OriginatorUserID), AuthorizingUserName: u.Name, AgentID: planningUUID(agent.ID), RunID: planningUUID(run.ID), IssueID: planningUUID(run.IssueID), RuntimeID: planningUUID(run.RuntimeID)}
	return a, nil
}
func inputSameSource(agent, issue, authorizer pgtype.UUID, a cockpitInputAuthority) bool {
	return a.Principal.ActorType == "agent" && agent == a.Run.AgentID && issue == a.Run.IssueID && authorizer == a.Run.OriginatorUserID
}
func inputHumanManager(p CockpitInputRead, member db.Member, row db.CockpitInput) bool {
	return p.ActorSource == "human" && (p.CredentialOwnerID == row.AuthorizingUserID || member.Role == "owner" || member.Role == "admin")
}
