package service

import (
	"context"
	"errors"
	"path/filepath"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

// ProvisionCockpitMeetingDirectory adapts the old no-key command to the same
// durable plan and executor. It never performs filesystem writes itself.
func (s *IssueService) ProvisionCockpitMeetingDirectory(ctx context.Context, p CockpitDirectoryRead, in CockpitLegacyDirectoryInput) (CockpitLegacyDirectoryResult, error) {
	out := CockpitLegacyDirectoryResult{Directory: in.Directory}
	if p.ActorSource == "cloud_pat" {
		return out, directoryError("task_context_required", "A cloud-node credential can read existing plans but cannot authorize directory preparation.")
	}
	executionCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	tx, _, m, err := s.directoryRead(executionCtx, p)
	if err != nil {
		return out, err
	}
	// Release the read transaction before inspecting NAS. New authorization is
	// checked again by the canonical preview/create path, not inferred here.
	_ = tx.Rollback(executionCtx)
	if s.CockpitDirectoryConfigurationError != "" {
		return out, directoryError("prepare_configuration_invalid", "The directory root configuration is invalid. Ask an administrator to correct it.")
	}
	if s.CockpitDirectoryPreparer == nil {
		return out, directoryError("prepare_not_configured", "Directory preparation is not configured for this workspace.")
	}
	root, err := s.CockpitDirectoryPreparer.PreparationRoot(util.UUIDToString(p.WorkspaceID))
	if err != nil {
		return out, directoryConvertError(err)
	}
	if !filepath.IsAbs(in.Directory) {
		return out, directoryError("prepare_path_outside_scope", "Choose an absolute directory within an explicitly authorized preparation scope.")
	}
	relative, err := filepath.Rel(root.Path, filepath.Clean(in.Directory))
	if err != nil {
		return out, directoryError("prepare_path_outside_scope", "The directory is outside its configured preparation scope.")
	}
	target, err := s.CockpitDirectoryPreparer.ResolvePreparation(util.UUIDToString(p.WorkspaceID), root.RootID, relative)
	if err != nil {
		return out, directoryConvertError(err)
	}
	out.Directory = target.Directory
	input := CockpitDirectoryPreviewInput{Mode: "prepare", RootID: root.RootID, RelativeDirectory: relative, Partitions: []string{"会议纪要与录音转写", "会议材料", "照片"}, ObservedNASDir: m.NasDir, ObservedBindingRevision: m.NasDirRevision, BindAfterBase: filepath.Clean(m.NasDir) != target.Directory}
	preview, err := s.PreviewCockpitMeetingDirectory(executionCtx, p, input)
	if err != nil {
		return out, err
	}
	q := s.Queries
	authorizing, sourceIssue := p.CredentialOwnerID, pgtype.UUID{}
	actorType, actor := "member", p.CredentialOwnerID
	switch p.ActorSource {
	case "human":
	case "task_token":
		actorType, actor = "agent", p.AgentID
		if !actor.Valid || !p.TaskTokenID.Valid || !p.RunID.Valid {
			return out, directoryError("task_context_required", "The authenticated task binding is required.")
		}
		token, e := q.ReadLiveCockpitDirectoryTaskToken(executionCtx, db.ReadLiveCockpitDirectoryTaskTokenParams{WorkspaceID: p.WorkspaceID, ID: p.TaskTokenID})
		if errors.Is(e, pgx.ErrNoRows) {
			return out, directoryError("task_context_required", "The authenticated task credential is unavailable.")
		}
		if e != nil {
			return out, e
		}
		if token.TaskID != p.RunID || token.AgentID != p.AgentID || token.UserID != p.CredentialOwnerID {
			return out, directoryError("task_context_required", "The credential does not match this exact task principal.")
		}
		source, e := q.GetAgentTaskInWorkspace(executionCtx, db.GetAgentTaskInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: p.RunID})
		if errors.Is(e, pgx.ErrNoRows) {
			return out, directoryError("delegation_unavailable", "The original source task is unavailable.")
		}
		if e != nil {
			return out, e
		}
		if source.AgentID != p.AgentID || !source.OriginatorUserID.Valid || !source.IssueID.Valid || source.ChatSessionID.Valid {
			return out, directoryError("delegation_unavailable", "A precise Issue-backed authorizing member is required.")
		}
		// Natural reuse is not new admission: a terminal same-source Run may
		// inspect and continue its already-accepted grant. Another Issue or
		// originator of the same Agent must never select that grant by accident.
		authorizing, sourceIssue = source.OriginatorUserID, source.IssueID

	default:
		return out, directoryError("task_context_required", "The authenticated principal is not supported.")
	}
	find := db.FindLegacyCockpitDirectoryPlanParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, CreatedByType: actorType, CreatedBy: actor, PlanHash: preview.PlanHash, AuthorizingUserID: authorizing, SourceIssueID: sourceIssue}
	// Use the ordinary query handle after ending the snapshot transaction.
	existing, findErr := q.FindLegacyCockpitDirectoryPlan(executionCtx, find)
	if findErr != nil && !errors.Is(findErr, pgx.ErrNoRows) {
		return out, findErr
	}
	if findErr == nil {
		if !legacyDirectoryTargetMatches(existing, preview.Target) {
			return out, directoryError("command_conflict", "An existing plan does not match the exact requested directory.")
		}
		prior, readErr := s.readLegacyDirectoryResult(executionCtx, p, existing.ID)
		if readErr != nil {
			return prior, readErr
		}
		if !existing.FinishedAt.Valid && existing.ResponsibleUserID != authorizing {
			return prior, directoryError("permission_revoked", "This plan now belongs to another responsible member. Open its recorded operation instead of reusing the old command.")
		}

		if existing.State == "completed" {
			allExist := len(preview.Steps) > 0
			for _, step := range preview.Steps {
				allExist = allExist && step.PlannedState == "exists"
			}
			if allExist && !input.BindAfterBase {
				return prior, nil
			}
			out = prior
			out.BaseReady = false
			input.Mode = "repair"
			preview, err = s.PreviewCockpitMeetingDirectory(executionCtx, p, input)
			if err != nil {
				prior.BaseReady = false
				return prior, err
			}
		} else if existing.State != "abandoned" {
			if existing.State != "active" {
				return prior, nil
			}
			driveErr := s.DriveCockpitDirectoryOperation(executionCtx, p.WorkspaceID, p.MeetingID, existing.ID)
			return s.finishLegacyDirectoryResult(ctx, p, existing.ID, prior, driveErr)
		}
	}
	if !preview.CanConfirm {
		code := "directory_preparation_blocked"
		if len(preview.BlockedReasons) > 0 {
			code = preview.BlockedReasons[0]
		}
		return out, directoryError(code, "Directory preparation cannot be authorized from the current facts. Review the recorded plan and its blocked reasons.")
	}
	// Preview supplies a verified principal; a new command still performs its
	// own locked admission and natural-target serialization.
	if preview.Principal == nil {
		return out, directoryError("task_context_required", "Directory preparation has no confirmed principal.")
	}
	command := CockpitDirectoryCreateInput{CockpitDirectoryPreviewInput: input, CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: m.NasDirRevision, ContextToken: preview.ContextToken}
	result, err := s.CreateCockpitMeetingDirectory(executionCtx, p, command)
	if err != nil {
		var conflict *CockpitDirectoryError
		if !errors.As(err, &conflict) || conflict.Code != "directory_operation_exists" {
			return out, err
		}
		out.OperationID = conflict.OperationID
		// A concurrent identical legacy request may win creation. Only this exact
		// actor and plan can reuse it; an existing foreign authorization is not a claim.
		won, lookupErr := q.FindLegacyCockpitDirectoryPlan(executionCtx, find)
		if lookupErr != nil || util.UUIDToString(won.ID) != conflict.OperationID || !legacyDirectoryTargetMatches(won, preview.Target) {
			return out, err
		}
		prior, readErr := s.readLegacyDirectoryResult(executionCtx, p, won.ID)
		if readErr != nil {
			return prior, readErr
		}
		if !won.FinishedAt.Valid && won.ResponsibleUserID != authorizing {
			return prior, directoryError("permission_revoked", "This plan now belongs to another responsible member. Open its recorded operation instead of reusing the old command.")
		}

		if won.State != "active" {
			return prior, nil
		}
		driveErr := s.DriveCockpitDirectoryOperation(executionCtx, p.WorkspaceID, p.MeetingID, won.ID)
		return s.finishLegacyDirectoryResult(ctx, p, won.ID, prior, driveErr)
	}
	operationID, err := util.ParseUUID(result.Receipt.DirectoryOperationID)
	if err != nil {
		return out, err
	}
	prior, err := s.readLegacyDirectoryResult(executionCtx, p, operationID)
	if err != nil {
		return prior, err
	}
	driveErr := s.DriveCockpitDirectoryOperation(executionCtx, p.WorkspaceID, p.MeetingID, operationID)
	return s.finishLegacyDirectoryResult(ctx, p, operationID, prior, driveErr)
}

func legacyDirectoryTargetMatches(row db.CockpitMeetingDirectoryOperation, target CockpitDirectoryTarget) bool {
	return util.UUIDToString(row.RootID) == target.RootID && row.RootPath == target.RootPath && row.RelativeDirectory == target.RelativeDirectory && row.Directory == target.Directory && row.TargetHash == target.TargetHash
}
func (s *IssueService) readLegacyDirectoryResult(ctx context.Context, p CockpitDirectoryRead, id pgtype.UUID) (CockpitLegacyDirectoryResult, error) {
	out := CockpitLegacyDirectoryResult{OperationID: util.UUIDToString(id)}
	query := CockpitDirectoryQuery{CockpitDirectoryRead: p, OperationID: id}
	header, err := s.GetCockpitDirectoryOperation(ctx, query)
	if err != nil {
		return out, err
	}
	out.State, out.Directory = header.State, header.Target.Directory
	steps, err := s.ListCockpitDirectorySteps(ctx, query)
	if err != nil {
		return out, err
	}
	for _, step := range steps.Items {
		if step.Kind == "base" {
			out.BaseReady = step.State == "satisfied"
		}
	}
	if out.State != "completed" {
		out.ErrorCode = "directory_preparation_incomplete"
		out.ErrorMessage = "Directory preparation is not complete. Open its recorded plan to check the remaining steps."
		if len(header.BlockedReasons) > 0 {
			out.ErrorCode = header.BlockedReasons[0]
		}
	} else if !out.BaseReady {
		out.ErrorCode = "directory_preparation_unconfirmed"
		out.ErrorMessage = "The recorded plan does not confirm its base directory. Open its details before trying again."
	}
	return out, nil
}
func (s *IssueService) finishLegacyDirectoryResult(ctx context.Context, p CockpitDirectoryRead, id pgtype.UUID, prior CockpitLegacyDirectoryResult, driveErr error) (CockpitLegacyDirectoryResult, error) {
	// Execution has an eight-second budget. A final bounded metadata read can
	// report a committed partial result even after that execution budget expires.
	readCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	out, err := s.readLegacyDirectoryResult(readCtx, p, id)
	if err != nil {
		prior.ErrorCode = "directory_preparation_unconfirmed"
		prior.ErrorMessage = "The latest directory result could not be confirmed. Open the recorded plan before trying again."
		return prior, nil
	}
	if driveErr != nil && out.State != "completed" {
		if errors.Is(driveErr, context.DeadlineExceeded) || errors.Is(driveErr, context.Canceled) {
			out.ErrorCode = "directory_preparation_incomplete"
		} else {
			out.ErrorCode = directoryCode(driveErr)
		}
		out.ErrorMessage = "Directory preparation is not complete. Open its recorded plan to check the remaining steps."
	}
	return out, nil
}
