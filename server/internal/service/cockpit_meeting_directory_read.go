package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"slices"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (s *IssueService) ListCockpitDirectoryRoots(ctx context.Context, p CockpitDirectoryQuery) (CockpitDirectoryRootPage, error) {
	size, err := planningPageSize(p.PageSize)
	if err != nil {
		return CockpitDirectoryRootPage{}, err
	}
	out := CockpitDirectoryRootPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), PageSize: size, Items: []CockpitDirectoryRootMetadata{}}
	if _, err = directoryMembership(ctx, s.Queries, p.CockpitDirectoryRead); err != nil {
		return out, err
	}
	if p.ActorSource == "cloud_pat" {
		return out, directoryError("task_context_required", "A cloud-node credential can only read existing directory plans.")
	}
	if p.Cursor != "" {
		return out, directoryError("invalid_input", "The workspace has at most one preparation root; no continuation cursor is valid.")
	}
	if s.CockpitDirectoryConfigurationError != "" {
		return out, directoryError("prepare_configuration_invalid", "The deployment's directory preparation configuration needs correction.")
	}
	if s.CockpitDirectoryPreparer == nil {
		return out, nil
	}
	r, err := s.CockpitDirectoryPreparer.PreparationRoot(out.WorkspaceID)
	if directoryCode(err) == "prepare_not_configured" {
		return out, nil
	}
	if err != nil {
		return out, directoryConvertError(err)
	}
	out.Items = append(out.Items, CockpitDirectoryRootMetadata{RootID: r.RootID, RootPath: r.Path, PrepareSubpathCount: int32(len(r.Subpaths))})
	out.Total = 1
	return out, nil
}

func (s *IssueService) GetCockpitDirectoryRoot(ctx context.Context, p CockpitDirectoryQuery) (CockpitDirectoryRootDetail, error) {
	page, err := s.ListCockpitDirectoryRoots(ctx, p)
	if err != nil {
		return CockpitDirectoryRootDetail{}, err
	}
	if len(page.Items) != 1 || page.Items[0].RootID != util.UUIDToString(p.RootID) {
		return CockpitDirectoryRootDetail{}, directoryError("not_found", "The selected preparation root is unavailable in this workspace.")
	}
	r, err := s.CockpitDirectoryPreparer.PreparationRoot(page.WorkspaceID)
	if err != nil {
		return CockpitDirectoryRootDetail{}, directoryConvertError(err)
	}
	return CockpitDirectoryRootDetail{WorkspaceID: page.WorkspaceID, CockpitDirectoryRootMetadata: page.Items[0], PrepareSubpaths: r.Subpaths}, nil
}

func (s *IssueService) GetCockpitMeetingDirectory(ctx context.Context, p CockpitDirectoryRead) (CockpitDirectorySummary, error) {
	var out CockpitDirectorySummary
	tx, q, m, err := s.directoryRead(ctx, p)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	out = CockpitDirectorySummary{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), GeneratedAt: directoryTime(), Binding: CockpitDirectoryBinding{NASDir: m.NasDir, Revision: m.NasDirRevision}, Capabilities: CockpitDirectoryCapabilities{Available: s.CockpitMeetingDirectoryBackendReady}, BlockedReasons: []string{}}
	out.BindingCandidate, out.BindingCandidateReason = s.directoryCandidate(p.WorkspaceID, m.NasDir)
	_, admissionErr := directoryPrincipal(ctx, q, p, false)
	if admissionErr != nil {
		out.BlockedReasons = append(out.BlockedReasons, directoryCode(admissionErr))
	} else if e := directoryNewPreparation(m); e != nil {
		out.BlockedReasons = append(out.BlockedReasons, directoryCode(e))
	} else if s.CockpitDirectoryConfigurationError != "" {
		out.BlockedReasons = append(out.BlockedReasons, "prepare_configuration_invalid")
	} else if s.CockpitDirectoryPreparer == nil {
		out.BlockedReasons = append(out.BlockedReasons, "prepare_not_configured")
	} else if _, e := s.CockpitDirectoryPreparer.PreparationRoot(out.WorkspaceID); e != nil {
		out.BlockedReasons = append(out.BlockedReasons, directoryCode(e))
	} else {
		out.Capabilities.CanPreview = true
		out.Capabilities.CanCreate = true
	}
	counts, err := q.CountCockpitDirectoryOperations(ctx, db.CountCockpitDirectoryOperationsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID})
	if err != nil {
		return out, err
	}
	out.HistoryTotal, out.UnfinishedTotal, out.NeedsAttentionTotal = counts.Total, counts.Unfinished, counts.NeedsAttention
	current, err := q.GetCurrentCockpitDirectoryOperation(ctx, db.GetCurrentCockpitDirectoryOperationParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID})
	if err == nil {
		headers, e := s.directoryHeaders(ctx, q, p, m, []db.CockpitMeetingDirectoryOperation{current})
		if e != nil {
			return out, e
		}
		out.Current = &headers[0]
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	return out, nil
}

func (s *IssueService) directoryHeaders(ctx context.Context, q *db.Queries, p CockpitDirectoryRead, m db.CockpitMeeting, rows []db.CockpitMeetingDirectoryOperation) ([]CockpitDirectoryOperationHeader, error) {
	out := make([]CockpitDirectoryOperationHeader, 0, len(rows))
	if len(rows) == 0 {
		return out, nil
	}
	ids, keys, users := []pgtype.UUID{}, []pgtype.UUID{}, []pgtype.UUID{}
	for _, o := range rows {
		ids = append(ids, o.ID)
		keys = append(keys, o.LastGrantCommandKey)
		users = append(users, o.ResponsibleUserID)
	}
	cs, err := q.ReadCockpitDirectoryOperationCounts(ctx, db.ReadCockpitDirectoryOperationCountsParams{WorkspaceID: p.WorkspaceID, Column2: ids})
	if err != nil {
		return out, err
	}
	counts := map[pgtype.UUID]CockpitDirectoryCounts{}
	for _, c := range cs {
		counts[c.OperationID] = CockpitDirectoryCounts{Total: c.Total, Pending: c.Pending, Running: c.Running, RetryWait: c.RetryWait, Satisfied: c.Satisfied, NeedsAttention: c.NeedsAttention, Abandoned: c.Abandoned}
	}
	steps, err := q.ListCockpitDirectoryUnfinishedSteps(ctx, db.ListCockpitDirectoryUnfinishedStepsParams{WorkspaceID: p.WorkspaceID, Column2: ids})
	if err != nil {
		return out, err
	}
	knownKeys := map[pgtype.UUID]bool{}
	for _, key := range keys {
		knownKeys[key] = true
	}
	for _, step := range steps {
		if !knownKeys[step.GrantCommandKey] {
			keys = append(keys, step.GrantCommandKey)
			knownKeys[step.GrantCommandKey] = true
		}
	}
	gr, err := q.ReadCockpitDirectoryGrants(ctx, db.ReadCockpitDirectoryGrantsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, Column3: keys})
	if err != nil {
		return out, err
	}
	grants := map[pgtype.UUID]CockpitDirectoryGrant{}
	for _, g := range gr {
		var v CockpitDirectoryGrant
		if e := json.Unmarshal(g.Grant, &v); e != nil {
			return out, e
		}
		if v.CommandKey != util.UUIDToString(g.CommandKey) {
			return out, fmt.Errorf("directory grant does not identify its original command")
		}
		grants[g.CommandKey] = v
	}
	grantProblems, err := s.ValidateCockpitDirectoryGrants(ctx, q, p, m, rows, steps, grants)
	if err != nil {
		return out, err
	}
	delegated := map[pgtype.UUID]bool{}
	for _, step := range steps {
		if grants[step.GrantCommandKey].Kind == "delegated_task" {
			delegated[step.OperationID] = true
		}
	}
	people, err := q.GetUsersByIDs(ctx, users)
	if err != nil {
		return out, err
	}
	names := map[pgtype.UUID]string{}
	for _, u := range people {
		names[u.ID] = u.Name
	}
	member, err := directoryMembership(ctx, q, p)
	if err != nil {
		return out, err
	}
	principal, admissionErr := directoryPrincipal(ctx, q, p, false)
	for _, o := range rows {
		grant, found := grants[o.LastGrantCommandKey]
		if !found {
			return out, fmt.Errorf("directory operation has no retained grant")
		}
		var source CockpitDirectoryPrincipal
		if err = json.Unmarshal(o.SourcePrincipal, &source); err != nil {
			return out, err
		}
		h := CockpitDirectoryOperationHeader{WorkspaceID: util.UUIDToString(o.WorkspaceID), MeetingID: util.UUIDToString(o.MeetingID), ID: util.UUIDToString(o.ID), Revision: o.Revision, State: o.State, CommandKey: util.UUIDToString(o.CreationCommandKey), RequestHash: o.RequestHash, PlanHash: o.PlanHash, Target: directoryRowTarget(o), CreatedByType: o.CreatedByType, CreatedBy: util.UUIDToString(o.CreatedBy), CreatedByName: source.ActorName, SourcePrincipal: source, ResponsibleUserID: util.UUIDToString(o.ResponsibleUserID), ResponsibleUserName: names[o.ResponsibleUserID], LastGrant: grant, CreatedAt: o.CreatedAt.Time.UTC().Format(time.RFC3339Nano), UpdatedAt: o.UpdatedAt.Time.UTC().Format(time.RFC3339Nano), FinishedAt: timestamp(o.FinishedAt), ObservedBinding: CockpitDirectoryBinding{NASDir: o.ObservedNasDir, Revision: o.ObservedBindingRevision}, BindAfterBase: o.BindAfterBase, BindingResult: o.BindingResult, Counts: counts[o.ID], BlockedReasons: []string{}}
		if o.AcceptedBindingRevision.Valid {
			v := o.AcceptedBindingRevision.Int64
			h.AcceptedBindingRevision = &v
		}
		human := p.ActorSource == "human"
		manager := human && (o.AuthorizingUserID == p.CredentialOwnerID || member.Role == "owner" || member.Role == "admin")
		responsible := human && o.ResponsibleUserID == p.CredentialOwnerID
		if p.ActorSource == "task_token" && admissionErr == nil {
			responsible = principal.AuthorizingUserID == h.ResponsibleUserID && principal.AuthorizingUserID == source.AuthorizingUserID && principal.ActorID == source.ActorID && principal.IssueID != nil && source.IssueID != nil && *principal.IssueID == *source.IssueID
		}
		unfinished := !o.FinishedAt.Valid
		h.CanPause = unfinished && o.State == "active" && (responsible || manager)
		h.CanAbandon = unfinished && (responsible || manager)
		h.CanClaim = unfinished && manager && (!responsible || delegated[o.ID])
		h.CanResume = unfinished && responsible && o.State == "paused"
		if h.CanResume && !directoryCanResumeSteps(steps, o.ID) {
			h.CanResume = false
			h.BlockedReasons = append(h.BlockedReasons, "directory_retry_required")
		}
		h.CanRetry = unfinished && responsible && (h.Counts.NeedsAttention > 0 || h.Counts.RetryWait > 0 ||
			(h.Counts.Pending > 0 && (o.State == "paused" || o.State == "needs_attention") && len(grantProblems[o.ID]) > 0))
		if len(grantProblems[o.ID]) > 0 {
			h.CanResume = false
			h.BlockedReasons = append(h.BlockedReasons, grantProblems[o.ID]...)
		}
		if err := directoryExistingPreparation(m, o); err != nil {
			h.CanResume = false
			h.CanRetry = false
			h.CanClaim = false
			h.BlockedReasons = append(h.BlockedReasons, directoryCode(err))
		}
		if err := directoryRegrantBinding(m, o, steps); err != nil {
			h.CanRetry = false
			h.CanClaim = false
			h.BlockedReasons = append(h.BlockedReasons, directoryCode(err))
		}
		if admissionErr != nil && !human {
			h.CanPause = false
			h.CanAbandon = false
			h.BlockedReasons = append(h.BlockedReasons, directoryCode(admissionErr))
		}
		if !responsible && !manager {
			h.BlockedReasons = append(h.BlockedReasons, "directory_responsible_required")
		}
		if m.OccurrenceState == "cancelled" {
			h.CanResume = false
			h.CanRetry = false
			h.BlockedReasons = append(h.BlockedReasons, "meeting_cancelled")
		}
		if s.CockpitDirectoryConfigurationError != "" {
			h.CanResume = false
			h.CanRetry = false
			h.CanClaim = false
			h.BlockedReasons = append(h.BlockedReasons, "prepare_configuration_invalid")
		} else if s.CockpitDirectoryPreparer == nil {
			h.CanResume = false
			h.CanRetry = false
			h.CanClaim = false
			h.BlockedReasons = append(h.BlockedReasons, "prepare_not_configured")
		} else if current, e := s.CockpitDirectoryPreparer.ResolvePreparation(h.WorkspaceID, h.Target.RootID, h.Target.RelativeDirectory); e != nil {
			h.CanResume = false
			h.CanRetry = false
			h.CanClaim = false
			h.BlockedReasons = append(h.BlockedReasons, directoryCode(e))
		} else if current.RootPath != h.Target.RootPath || current.Directory != h.Target.Directory {
			h.CanResume = false
			h.CanRetry = false
			h.CanClaim = false
			h.BlockedReasons = append(h.BlockedReasons, "root_target_changed")
		} else {
			for _, step := range steps {
				if step.OperationID != o.ID {
					continue
				}
				relative, err := filepath.Rel(filepath.Join(current.RootPath, current.PrepareSubpath), filepath.Join(current.RootPath, step.RelativePath))
				if err != nil || !filepath.IsLocal(relative) {
					h.CanClaim = false
					h.BlockedReasons = append(h.BlockedReasons, "prepare_path_outside_scope")
				}
			}
		}
		sort.Strings(h.BlockedReasons)
		h.BlockedReasons = slices.Compact(h.BlockedReasons)
		out = append(out, h)
	}
	return out, nil
}

func (s *IssueService) ListCockpitDirectoryAttempts(ctx context.Context, p CockpitDirectoryQuery) (CockpitDirectoryAttemptPage, error) {
	var out CockpitDirectoryAttemptPage
	size, err := planningPageSize(p.PageSize)
	if err != nil {
		return out, err
	}
	scope := planningHash([]any{"directory_attempts_newest", p.WorkspaceID, p.MeetingID, p.OperationID, p.StepID, size})
	cursor, afterID, err := decodeLifecycleCursor(p.Cursor, scope, 0)
	if err != nil {
		return out, err
	}
	var before int32
	if afterID.Valid {
		if cursor.Order < 1 || cursor.Order > math.MaxInt32 {
			return out, directoryError("invalid_input", "The directory attempt cursor is invalid.")
		}
		before = int32(cursor.Order)
	}
	tx, q, _, err := s.directoryRead(ctx, p.CockpitDirectoryRead)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if err = directoryAttemptParent(ctx, q, p); err != nil {
		return out, err
	}
	rows, err := q.ListCockpitDirectoryAttempts(ctx, db.ListCockpitDirectoryAttemptsParams{WorkspaceID: p.WorkspaceID, StepID: p.StepID, BeforeNumber: before, PageLimit: size + 1})
	if err != nil {
		return out, err
	}
	total, err := q.CountCockpitDirectoryAttempts(ctx, db.CountCockpitDirectoryAttemptsParams{WorkspaceID: p.WorkspaceID, StepID: p.StepID})
	if err != nil {
		return out, err
	}
	out = CockpitDirectoryAttemptPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), OperationID: util.UUIDToString(p.OperationID), StepID: util.UUIDToString(p.StepID), PageSize: size, Items: []CockpitDirectoryAttemptMetadata{}, Total: total}
	if len(rows) > int(size) {
		rows = rows[:size]
		last := rows[len(rows)-1]
		out.NextCursor = encodeLifecycleCursor(lifecycleCursor{Scope: scope, ID: util.UUIDToString(last.ID), Order: int64(last.AttemptNumber)})
	}
	for _, row := range rows {
		out.Items = append(out.Items, CockpitDirectoryAttemptMetadata{ID: util.UUIDToString(row.ID), StepID: util.UUIDToString(row.StepID), AttemptNumber: row.AttemptNumber, State: row.State, StartedAt: row.StartedAt.Time.UTC().Format(time.RFC3339Nano), FinishedAt: timestamp(row.FinishedAt), ErrorCode: row.ErrorCode, Outcome: planningText(row.Outcome), ObservedAt: timestamp(row.ObservedAt)})
	}
	return out, nil
}

// The full parent tuple is checked before the metadata query uses its indexed step identity.
func directoryAttemptParent(ctx context.Context, q *db.Queries, p CockpitDirectoryQuery) error {
	if _, err := q.GetCockpitDirectoryOperation(ctx, db.GetCockpitDirectoryOperationParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.OperationID}); err != nil {
		return directoryConvertError(err)
	}
	_, err := q.GetCockpitDirectoryStep(ctx, db.GetCockpitDirectoryStepParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, OperationID: p.OperationID, ID: p.StepID})
	return directoryConvertError(err)
}

func (s *IssueService) GetCockpitDirectoryAttempt(ctx context.Context, p CockpitDirectoryQuery) (CockpitDirectoryAttemptDetail, error) {
	var out CockpitDirectoryAttemptDetail
	tx, q, _, err := s.directoryRead(ctx, p.CockpitDirectoryRead)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if err = directoryAttemptParent(ctx, q, p); err != nil {
		return out, err
	}
	row, err := q.GetCockpitDirectoryAttempt(ctx, db.GetCockpitDirectoryAttemptParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, OperationID: p.OperationID, StepID: p.StepID, ID: p.AttemptID})
	if err != nil {
		return out, directoryConvertError(err)
	}
	out = CockpitDirectoryAttemptDetail{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), OperationID: util.UUIDToString(p.OperationID),
		CockpitDirectoryAttemptMetadata: CockpitDirectoryAttemptMetadata{ID: util.UUIDToString(row.ID), StepID: util.UUIDToString(row.StepID), AttemptNumber: row.AttemptNumber, State: row.State, StartedAt: row.StartedAt.Time.UTC().Format(time.RFC3339Nano), FinishedAt: timestamp(row.FinishedAt), ErrorCode: row.ErrorCode, Outcome: planningText(row.Outcome), ObservedAt: timestamp(row.ObservedAt)},
		GrantCommandKey:                 util.UUIDToString(row.GrantCommandKey), GrantRevision: row.GrantRevision, ErrorMessage: row.ErrorMessage, LateObservedAt: timestamp(row.LateObservedAt)}
	for _, field := range []struct {
		raw []byte
		to  **CockpitDirectoryObservation
	}{{row.Receipt, &out.Receipt}, {row.LateReceipt, &out.LateReceipt}} {
		if len(field.raw) != 0 {
			if err := json.Unmarshal(field.raw, field.to); err != nil {
				return CockpitDirectoryAttemptDetail{}, err
			}
		}
	}
	return out, nil
}

func (s *IssueService) GetCockpitDirectoryOperation(ctx context.Context, p CockpitDirectoryQuery) (CockpitDirectoryOperationHeader, error) {
	tx, q, m, err := s.directoryRead(ctx, p.CockpitDirectoryRead)
	if err != nil {
		return CockpitDirectoryOperationHeader{}, err
	}
	defer tx.Rollback(ctx)
	o, err := q.GetCockpitDirectoryOperation(ctx, db.GetCockpitDirectoryOperationParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.OperationID})
	if err != nil {
		return CockpitDirectoryOperationHeader{}, directoryConvertError(err)
	}
	rows, err := s.directoryHeaders(ctx, q, p.CockpitDirectoryRead, m, []db.CockpitMeetingDirectoryOperation{o})
	if err != nil {
		return CockpitDirectoryOperationHeader{}, err
	}
	return rows[0], nil
}

func (s *IssueService) ListCockpitDirectoryOperations(ctx context.Context, p CockpitDirectoryQuery) (CockpitDirectoryOperationPage, error) {
	var out CockpitDirectoryOperationPage
	size, err := planningPageSize(p.PageSize)
	if err != nil {
		return out, err
	}
	scope := planningHash([]any{"directory_operations_newest", p.WorkspaceID, p.MeetingID, size})
	c, id, err := decodeLifecycleCursor(p.Cursor, scope, 0)
	if err != nil {
		return out, err
	}
	var after pgtype.Timestamptz
	if id.Valid {
		v, e := time.Parse(time.RFC3339Nano, c.Time)
		if e != nil {
			return out, ErrCockpitWorkflowInput
		}
		after = pgtype.Timestamptz{Time: v, Valid: true}
	}
	tx, q, m, err := s.directoryRead(ctx, p.CockpitDirectoryRead)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	rows, err := q.ListCockpitDirectoryOperations(ctx, db.ListCockpitDirectoryOperationsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, AfterID: id, AfterTime: after, PageLimit: size + 1})
	if err != nil {
		return out, err
	}
	out = CockpitDirectoryOperationPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), PageSize: size, Items: []CockpitDirectoryOperationHeader{}}
	count, err := q.CountCockpitDirectoryOperations(ctx, db.CountCockpitDirectoryOperationsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID})
	if err != nil {
		return out, err
	}
	out.Total = count.Total
	if len(rows) > int(size) {
		rows = rows[:size]
		last := rows[len(rows)-1]
		cursor := encodeLifecycleCursor(lifecycleCursor{Scope: scope, ID: util.UUIDToString(last.ID), Time: last.CreatedAt.Time.UTC().Format(time.RFC3339Nano)})
		out.NextCursor = cursor
	}
	metadata := make([]db.CockpitMeetingDirectoryOperation, len(rows))
	for index, row := range rows {
		metadata[index] = db.CockpitMeetingDirectoryOperation(row)
	}
	out.Items, err = s.directoryHeaders(ctx, q, p.CockpitDirectoryRead, m, metadata)
	return out, err
}

func (s *IssueService) ListCockpitDirectorySteps(ctx context.Context, p CockpitDirectoryQuery) (CockpitDirectoryStepPage, error) {
	var out CockpitDirectoryStepPage
	tx, q, m, err := s.directoryRead(ctx, p.CockpitDirectoryRead)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	o, err := q.GetCockpitDirectoryOperation(ctx, db.GetCockpitDirectoryOperationParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.OperationID})
	if err != nil {
		return out, directoryConvertError(err)
	}
	headers, err := s.directoryHeaders(ctx, q, p.CockpitDirectoryRead, m, []db.CockpitMeetingDirectoryOperation{o})
	if err != nil {
		return out, err
	}
	h := headers[0]
	rows, err := q.ListCockpitDirectorySteps(ctx, db.ListCockpitDirectoryStepsParams{WorkspaceID: p.WorkspaceID, OperationID: p.OperationID})
	if err != nil {
		return out, err
	}
	if len(rows) > 32 {
		return out, ErrCockpitWorkflowConflict
	}
	out = CockpitDirectoryStepPage{WorkspaceID: h.WorkspaceID, MeetingID: h.MeetingID, OperationID: h.ID, Items: []CockpitDirectoryStepMetadata{}, Total: int64(len(rows)), Counts: h.Counts}
	preparationScope := ""
	if h.CanRetry && s.CockpitDirectoryPreparer != nil {
		target, err := s.CockpitDirectoryPreparer.ResolvePreparation(h.WorkspaceID, h.Target.RootID, h.Target.RelativeDirectory)
		if err == nil {
			preparationScope = filepath.Join(target.RootPath, target.PrepareSubpath)
		}
	}
	for _, r := range rows {
		canRetry := h.CanRetry && (r.State == "needs_attention" || r.State == "retry_wait" || r.State == "pending" && (h.State == "paused" || h.State == "needs_attention"))
		if canRetry {
			if preparationScope == "" {
				canRetry = false
			} else {
				relative, err := filepath.Rel(preparationScope, filepath.Join(h.Target.RootPath, r.RelativePath))
				canRetry = err == nil && filepath.IsLocal(relative)
			}
		}
		out.Items = append(out.Items, CockpitDirectoryStepMetadata{ID: util.UUIDToString(r.ID), OperationID: h.ID, Position: r.Position, Kind: r.Kind, Label: r.Label, RelativePath: r.RelativePath, State: r.State, Revision: r.Revision, GrantCommandKey: util.UUIDToString(r.GrantCommandKey), GrantRevision: r.GrantRevision, AttemptCount: r.AttemptCount, LastAttemptID: planningUUID(r.LastAttemptID), LastObservedAt: timestamp(r.LastObservedAt), Outcome: planningText(r.Outcome), LastErrorCode: r.LastErrorCode, CanRetry: canRetry, BlockedReasons: append([]string{}, h.BlockedReasons...)})
	}
	return out, nil
}
