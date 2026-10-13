package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type CockpitDirectoryError struct {
	Code, Message                                           string
	Retryable                                               bool
	WorkspaceID, MeetingID, RootID, OperationID, CommandKey string
	cause                                                   error
}

func (e *CockpitDirectoryError) Error() string { return e.Message }
func (e *CockpitDirectoryError) Unwrap() error {
	if e.cause != nil {
		return e.cause
	}
	return ErrCockpitWorkflowConflict
}
func directoryError(code, message string) *CockpitDirectoryError {
	cause := ErrCockpitWorkflowConflict
	switch code {
	case "invalid_input":
		cause = ErrCockpitWorkflowInput
	case "not_found":
		cause = ErrCockpitWorkflowNotFound
	case "target_gone":
		cause = ErrCockpitLifecycleGone
	case "permission_revoked", "task_context_required", "delegation_unavailable", "source_run_unavailable":
		cause = ErrCockpitWorkflowForbidden
	}
	return &CockpitDirectoryError{Code: code, Message: message, cause: cause}
}
func directoryConvertError(err error) error {
	if err == nil {
		return nil
	}
	var typed *CockpitDirectoryError
	if errors.As(err, &typed) {
		return typed
	}
	var ioError *cockpitnas.Error
	if errors.As(err, &ioError) {
		return &CockpitDirectoryError{Code: ioError.Code, Message: ioError.Message, Retryable: ioError.Retryable}
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return directoryError("not_found", "The requested directory preparation object is unavailable.")
	}
	return err
}
func directoryCode(err error) string {
	var e *CockpitDirectoryError
	if errors.As(directoryConvertError(err), &e) {
		return e.Code
	}
	return "read_unavailable"
}
func directoryTime() string {
	return time.Now().UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)
}
func directoryRaw(v any) []byte { b, _ := json.Marshal(v); return b }

func directoryMembership(ctx context.Context, q *db.Queries, p CockpitDirectoryRead) (db.Member, error) {
	if !p.WorkspaceID.Valid || !p.CredentialOwnerID.Valid {
		return db.Member{}, directoryError("permission_revoked", "A current workspace member is required.")
	}
	switch p.ActorSource {
	case "human", "task_token", "cloud_pat":
	default:
		return db.Member{}, directoryError("task_context_required", "A supported authenticated principal is required.")
	}
	m, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{WorkspaceID: p.WorkspaceID, UserID: p.CredentialOwnerID})
	if errors.Is(err, pgx.ErrNoRows) {
		return m, directoryError("permission_revoked", "The credential owner is no longer a workspace member.")
	}
	return m, err
}

// New delegation admission is distinct from continuation of an accepted grant.
// A caller taking locks already holds workspace/member/board/meeting first.
func directoryPrincipal(ctx context.Context, q *db.Queries, p CockpitDirectoryRead, lock bool) (CockpitDirectoryPrincipal, error) {
	return directoryPrincipalWithRetainedPlan(ctx, q, p, lock, nil)
}

// A matched retained plan permits only a terminal source Run, never a stale
// token, missing member, revoked invocation grant, or unrelated preparation Issue.
// This private path is used only after resolving the exact historical target.
func directoryPrincipalWithRetainedPlan(ctx context.Context, q *db.Queries, p CockpitDirectoryRead, lock bool, retained *db.CockpitMeetingDirectoryOperation) (CockpitDirectoryPrincipal, error) {
	var out CockpitDirectoryPrincipal
	if _, err := directoryMembership(ctx, q, p); err != nil {
		return out, err
	}
	user := util.UUIDToString(p.CredentialOwnerID)
	if p.ActorSource == "cloud_pat" {
		return out, directoryError("task_context_required", "A cloud-node credential can read existing plans but cannot authorize directory preparation.")
	}
	out = CockpitDirectoryPrincipal{Source: p.ActorSource, CredentialOwnerUserID: user, ActorType: "member", ActorID: user, AuthorizingUserID: user, ConfirmedByUserID: &user, RelationKind: "none"}
	if p.ActorSource == "task_token" {
		if !p.TaskTokenID.Valid || !p.RunID.Valid || !p.AgentID.Valid {
			return out, directoryError("task_context_required", "Directory delegation requires the authenticated task identity.")
		}
		token, err := q.ReadLiveCockpitDirectoryTaskToken(ctx, db.ReadLiveCockpitDirectoryTaskTokenParams{ID: p.TaskTokenID, WorkspaceID: p.WorkspaceID})
		if errors.Is(err, pgx.ErrNoRows) {
			return out, directoryError("source_run_unavailable", "The task credential is no longer valid for a new directory command.")
		}
		if err != nil {
			return out, err
		}
		if token.TaskID != p.RunID || token.AgentID != p.AgentID || token.UserID != p.CredentialOwnerID {
			return out, directoryError("task_context_required", "The task credential does not identify this command principal.")
		}
		run, err := q.GetAgentTaskInWorkspace(ctx, db.GetAgentTaskInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: p.RunID})
		if err != nil {
			return out, directoryConvertError(err)
		}
		if !run.OriginatorUserID.Valid || !run.IssueID.Valid || run.ChatSessionID.Valid {
			return out, directoryError("delegation_unavailable", "This run has no precise Issue-backed authorizing member.")
		}
		authorizer, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{WorkspaceID: p.WorkspaceID, UserID: run.OriginatorUserID})
		if errors.Is(err, pgx.ErrNoRows) {
			return out, directoryError("permission_revoked", "The run's authorizing member is no longer in this workspace.")
		}
		if err != nil {
			return out, err
		}
		_ = authorizer
		if !run.RuntimeID.Valid {
			return out, directoryError("source_run_unavailable", "The source run has no bound runtime.")
		}
		var runtime db.AgentRuntime
		var agent db.Agent
		if lock {
			runtime, err = q.LockCockpitInputRuntimeAuthority(ctx, run.RuntimeID)
			if err != nil {
				return out, err
			}
			agent, err = q.LockCockpitInputAgentAuthority(ctx, p.AgentID)
			if err != nil {
				return out, err
			}
			latest, e := q.LockCockpitDirectoryRun(ctx, db.LockCockpitDirectoryRunParams{WorkspaceID: p.WorkspaceID, ID: p.RunID})
			if e != nil {
				return out, e
			}
			if latest.OriginatorUserID != run.OriginatorUserID || latest.RuntimeID != run.RuntimeID || latest.IssueID != run.IssueID {
				return out, directoryError("source_run_unavailable", "The run delegation changed while authorizing this plan.")
			}
			run = latest
			token, err = q.GetLiveCockpitDirectoryTaskToken(ctx, db.GetLiveCockpitDirectoryTaskTokenParams{ID: p.TaskTokenID, WorkspaceID: p.WorkspaceID})
			if err != nil {
				return out, directoryConvertError(err)
			}
		} else {
			runtime, err = q.GetAgentRuntime(ctx, run.RuntimeID)
			if err != nil {
				return out, err
			}
			agent, err = q.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: p.AgentID})
			if err != nil {
				return out, err
			}
		}
		eligibleRun := run.Status == "dispatched" || run.Status == "running"
		if retained != nil {
			if retained.WorkspaceID != p.WorkspaceID || retained.MeetingID != p.MeetingID || retained.CreatedByType != "agent" || retained.CreatedBy != p.AgentID || retained.SourceAgentID != p.AgentID || retained.SourceIssueID != run.IssueID || retained.AuthorizingUserID != run.OriginatorUserID {
				return out, directoryError("delegation_unavailable", "The retained directory plan does not belong to this precise preparation source.")
			}
			eligibleRun = eligibleRun || run.Status == "completed" || run.Status == "failed" || run.Status == "cancelled"
		}
		if run.AgentID != p.AgentID || agent.WorkspaceID != p.WorkspaceID || agent.RuntimeID != run.RuntimeID || runtime.WorkspaceID != p.WorkspaceID || runtime.OwnerID != p.CredentialOwnerID || token.AgentID != p.AgentID || token.TaskID != run.ID || token.UserID != p.CredentialOwnerID || !cockpitAssignableAgentStatus(agent.Status) || !eligibleRun {
			return out, directoryError("source_run_unavailable", "The authenticated run is not currently eligible to authorize this directory plan.")
		}
		if runtime.Visibility == "private" && runtime.OwnerID != agent.OwnerID {
			return out, directoryError("permission_revoked", "The private runtime no longer authorizes the source Agent.")
		}
		allowed, err := memberMayInvokeAgent(ctx, q, agent, run.OriginatorUserID, p.WorkspaceID)
		if err != nil {
			return out, err
		}
		if !allowed {
			return out, directoryError("permission_revoked", "The run's authorizing member can no longer invoke this Agent.")
		}
		relation, err := q.GetCockpitDirectoryPreparationRelation(ctx, db.GetCockpitDirectoryPreparationRelationParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, IssueID: run.IssueID})
		if errors.Is(err, pgx.ErrNoRows) {
			return out, directoryError("delegation_unavailable", "The source Issue is not an active preparation task for this meeting.")
		}
		if err != nil {
			return out, err
		}
		out.ActorType = "agent"
		out.ActorID = util.UUIDToString(agent.ID)
		out.ActorName = agent.Name
		out.AuthorizingUserID = util.UUIDToString(run.OriginatorUserID)
		out.ConfirmedByUserID = nil
		out.RunID = planningUUID(run.ID)
		out.IssueID = planningUUID(run.IssueID)
		out.AgentID = planningUUID(agent.ID)
		out.RuntimeID = planningUUID(run.RuntimeID)
		out.RelationKind = relation
	}
	authorizing, _ := util.ParseUUID(out.AuthorizingUserID)
	users, err := q.GetUsersByIDs(ctx, []pgtype.UUID{p.CredentialOwnerID, authorizing})
	if err != nil {
		return out, err
	}
	for _, u := range users {
		if u.ID == authorizing {
			out.AuthorizingUserName = u.Name
		}
		if out.ActorType == "member" && u.ID == p.CredentialOwnerID {
			out.ActorName = u.Name
		}
	}
	return out, nil
}

func (s *IssueService) directoryRead(ctx context.Context, p CockpitDirectoryRead) (pgx.Tx, *db.Queries, db.CockpitMeeting, error) {
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return nil, nil, db.CockpitMeeting{}, err
	}
	fail := func(e error) (pgx.Tx, *db.Queries, db.CockpitMeeting, error) {
		_ = tx.Rollback(ctx)
		return nil, nil, db.CockpitMeeting{}, e
	}
	if _, err = directoryMembership(ctx, q, p); err != nil {
		return fail(err)
	}
	m, err := q.GetCockpitMeeting(ctx, db.GetCockpitMeetingParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID})
	if err != nil {
		return fail(directoryConvertError(err))
	}
	return tx, q, m, nil
}

func directoryTarget(t cockpitnas.PreparationTarget) CockpitDirectoryTarget {
	return CockpitDirectoryTarget{RootID: t.RootID, RootPath: t.RootPath, PrepareSubpath: t.PrepareSubpath, RelativeDirectory: t.RelativeDirectory, Directory: t.Directory, TargetHash: t.TargetHash, RootConfigHash: t.RootConfigHash}
}
func directoryFSTarget(ws pgtype.UUID, t CockpitDirectoryTarget) cockpitnas.PreparationTarget {
	return cockpitnas.PreparationTarget{WorkspaceID: util.UUIDToString(ws), RootID: t.RootID, RootPath: t.RootPath, PrepareSubpath: t.PrepareSubpath, RelativeDirectory: t.RelativeDirectory, Directory: t.Directory, TargetHash: t.TargetHash, RootConfigHash: t.RootConfigHash}
}
func directoryRowTarget(o db.CockpitMeetingDirectoryOperation) CockpitDirectoryTarget {
	return CockpitDirectoryTarget{RootID: util.UUIDToString(o.RootID), RootPath: o.RootPath, PrepareSubpath: o.PrepareSubpath, RelativeDirectory: o.RelativeDirectory, Directory: o.Directory, TargetHash: o.TargetHash, RootConfigHash: o.RootConfigHash}
}

func (s *IssueService) directoryCandidate(ws pgtype.UUID, binding string) (*CockpitDirectoryTarget, string) {
	if s.CockpitDirectoryPreparer == nil {
		return nil, "prepare_not_configured"
	}
	r, err := s.CockpitDirectoryPreparer.PreparationRoot(util.UUIDToString(ws))
	if err != nil {
		return nil, directoryCode(err)
	}
	if binding == "" {
		return nil, "binding_missing"
	}
	if !filepath.IsAbs(binding) {
		return nil, "prepare_path_outside_scope"
	}
	rel, err := filepath.Rel(r.Path, binding)
	if err != nil {
		return nil, "prepare_path_outside_scope"
	}
	t, err := s.CockpitDirectoryPreparer.ResolvePreparation(util.UUIDToString(ws), r.RootID, rel)
	if err != nil {
		return nil, directoryCode(err)
	}
	out := directoryTarget(t)
	return &out, ""
}

func directoryNewPreparation(m db.CockpitMeeting) error {
	if m.OccurrenceState == "cancelled" {
		return directoryError("meeting_cancelled", "Reinstate this meeting before authorizing new directory preparation.")
	}
	if m.ArchivedAt.Valid {
		return directoryError("meeting_archived", "Unarchive this meeting before authorizing new directory preparation.")
	}
	return nil
}

// Archiving organizes discovery; it does not abandon a previously accepted
// fixed plan. New targets/partitions still require directoryNewPreparation.
func directoryExistingPreparation(m db.CockpitMeeting, o db.CockpitMeetingDirectoryOperation) error {
	if m.OccurrenceState == "cancelled" {
		return directoryError("meeting_cancelled", "Reinstate this meeting before reauthorizing its remaining directory steps.")
	}
	if m.ArchivedAt.Valid && (!o.CreatedAt.Valid || o.CreatedAt.Time.After(m.ArchivedAt.Time)) {
		return directoryError("meeting_archived", "Unarchive the meeting before authorizing a new directory plan.")
	}
	return nil
}

// A retry may rebind only through the original, still-unfinished base step.
// It cannot turn a no-binding intent or a satisfied historical base into a new
// binding command. The selected base grant records the current observation.
func directoryRegrantBinding(m db.CockpitMeeting, o db.CockpitMeetingDirectoryOperation, steps []db.CockpitMeetingDirectoryStep) error {
	if m.NasDir == o.Directory {
		return nil
	}
	if o.BindAfterBase {
		for _, st := range steps {
			if st.OperationID == o.ID && st.Kind == "base" && st.State != "satisfied" && st.State != "abandoned" {
				return nil
			}
		}
	}
	return directoryError("binding_changed", "Restore the meeting's fixed directory binding explicitly, or create a new plan. These remaining steps cannot rebind a satisfied base.")
}
func directoryRetryBaseGrant(ctx context.Context, q *db.Queries, p CockpitDirectoryRead, m db.CockpitMeeting, o db.CockpitMeetingDirectoryOperation, all, selected []db.CockpitMeetingDirectoryStep) error {
	if err := directoryRegrantBinding(m, o, all); err != nil {
		return err
	}
	if m.NasDir == o.Directory {
		return nil
	}
	for _, base := range all {
		if base.Kind != "base" {
			continue
		}
		for _, st := range selected {
			if st.ID == base.ID {
				return nil
			}
		}
		grants, err := directoryGrants(ctx, q, p, []db.CockpitMeetingDirectoryStep{base})
		if err != nil {
			return err
		}
		g, ok := grants[base.GrantCommandKey]
		if !ok {
			return fmt.Errorf("the fixed base has no retained grant")
		}
		if g.ObservedBinding != directoryBinding(m) {
			return directoryError("base_reauthorization_required", "Include the original unfinished base step when reconfirming this changed binding.")
		}
	}
	return nil
}

func directoryCanResumeSteps(steps []db.CockpitMeetingDirectoryStep, operation pgtype.UUID) bool {
	unfinished := map[pgtype.UUID]string{}
	for _, step := range steps {
		if step.OperationID == operation && step.State != "satisfied" && step.State != "abandoned" {
			unfinished[step.ID] = step.State
		}
	}
	for _, step := range steps {
		if step.OperationID != operation {
			continue
		}
		if step.State == "running" {
			return true
		}
		if step.State == "pending" || step.State == "retry_wait" {
			if !step.ParentStepID.Valid {
				return true
			}
			if _, blocked := unfinished[step.ParentStepID]; !blocked {
				return true
			}
		}
	}
	return false
}

func directoryCommandKey(key string, revision int64) (pgtype.UUID, error) {
	id, err := util.ParseUUID(key)
	if err != nil || !id.Valid || revision < 1 {
		return id, directoryError("invalid_input", "A UUID command key and positive observed revision are required.")
	}
	return id, nil
}
func directoryRequestHash(p CockpitDirectoryRead, action string, body any) string {
	return planningHash([]any{action, p.WorkspaceID, p.MeetingID, p.ActorSource, p.CredentialOwnerID, p.AgentID, p.RunID, body})
}
func directoryTrimReason(reason string) (string, error) {
	reason = strings.TrimSpace(reason)
	if !preparationText(reason, 16000) {
		return "", directoryError("invalid_input", "The reason must fit within 16000 UTF-8 bytes.")
	}
	return reason, nil
}

func directoryGrantFromReceipt(raw []byte) (CockpitDirectoryGrant, error) {
	var envelope CockpitLifecycleReceipt
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return CockpitDirectoryGrant{}, err
	}
	if envelope.Directory == nil || envelope.Directory.Grant.CommandKey == "" {
		return CockpitDirectoryGrant{}, fmt.Errorf("directory command has no fixed grant")
	}
	return envelope.Directory.Grant, nil
}
