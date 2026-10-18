package service

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

var (
	ErrCockpitWorkflowInput            = errors.New("invalid meeting workflow input")
	ErrCockpitWorkflowConflict         = errors.New("meeting workflow changed; refresh and retry")
	ErrCockpitWorkflowForbidden        = errors.New("meeting workflow permission denied")
	ErrCockpitWorkflowNotFound         = errors.New("meeting workflow not found")
	ErrCockpitWorkflowExecutionBlocked = errors.New("meeting workflow issue is not available for agent execution")
)

type CockpitWorkPackageCommand struct {
	WorkspaceID, MeetingID, ActorID pgtype.UUID
	ExpectedRevision                int64
}
type CockpitWorkPackageInit struct {
	WorkspaceID, MeetingID, ActorID, ReviewerID, ExistingIssueID, NodeID pgtype.UUID
	NewIssue                                                             IssueCreateParams
}
type CockpitWorkPackageReadiness struct {
	CockpitWorkPackageCommand
	Ended, MaterialsReady *bool
}
type CockpitMinutesSubmission struct {
	CockpitWorkPackageCommand
	AuthorID           pgtype.UUID
	SubmissionKey      pgtype.UUID
	Content, ActorType string
}
type CockpitMinutesVersionCommand struct {
	CockpitWorkPackageCommand
	VersionID pgtype.UUID
	NASExport *CockpitMinutesExportTarget
}
type CockpitMinutesUnpublish struct {
	CockpitMinutesVersionCommand
	Reason string
}
type CockpitMinutesReview struct {
	CockpitMinutesVersionCommand
	Decision, Feedback string
}

// CockpitWorkflowIssue is an internal typed create hook, never an Issue API field.
// Prepare and link run inside IssueService.Create's transaction.
type CockpitWorkflowIssue struct {
	Handoff                 *CockpitReviewerHandoff
	handoffVersion          db.CockpitMinutesVersion
	handoffRetiredIssue     db.Issue
	handoffPreviousStatus   string
	handoffCancelledWakeups []db.AgentTaskQueue
	Init                    *CockpitWorkPackageInit
	Submission              *CockpitMinutesSubmission
	work                    cockpitMinutesState
	versionID               pgtype.UUID
}

func cockpitWorkflowError(err error) error {
	if IsCockpitArtifactIntegrityError(err) {
		return fmt.Errorf("%w: formal artifact or acceptance facts retain this object; use its formal workflow entry", ErrCockpitWorkflowConflict)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrCockpitWorkflowNotFound
	}
	return err
}
func cockpitWorkflowMember(ctx context.Context, q *db.Queries, ws, actor pgtype.UUID) error {
	if !actor.Valid {
		return ErrCockpitWorkflowForbidden
	}
	if _, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: actor, WorkspaceID: ws}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrCockpitWorkflowForbidden
		}
		return err
	}
	return nil
}
func lockCockpitWorkflowMeeting(ctx context.Context, q *db.Queries, ws, meeting pgtype.UUID) (db.CockpitMeeting, error) {
	if _, err := q.LockWorkspaceForChatSessionCreate(ctx, ws); err != nil {
		return db.CockpitMeeting{}, cockpitWorkflowError(err)
	}
	if _, err := q.LockCockpitForWorkspaceChanges(ctx, ws); err != nil {
		return db.CockpitMeeting{}, cockpitWorkflowError(err)
	}
	m, err := q.LockCockpitMeetingForWork(ctx, db.LockCockpitMeetingForWorkParams{ID: meeting, WorkspaceID: ws})
	return m, cockpitWorkflowError(err)
}
func (s *IssueService) beginCockpitWorkflow(ctx context.Context, c CockpitWorkPackageCommand) (pgx.Tx, *db.Queries, cockpitMinutesState, error) {
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return nil, nil, cockpitMinutesState{}, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('multica.actor_type','member',true),set_config('multica.actor_id',$1,true),set_config('multica.source_task_id','',true)`, util.UUIDToString(c.ActorID)); err != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, cockpitMinutesState{}, err
	}
	q := s.Queries.WithTx(tx)
	fail := func(e error) (pgx.Tx, *db.Queries, cockpitMinutesState, error) {
		_ = tx.Rollback(ctx)
		return nil, nil, cockpitMinutesState{}, e
	}
	if err := cockpitWorkflowMember(ctx, q, c.WorkspaceID, c.ActorID); err != nil {
		return fail(err)
	}
	if _, err := lockCockpitWorkflowMeeting(ctx, q, c.WorkspaceID, c.MeetingID); err != nil {
		return fail(err)
	}
	work, err := q.LockCockpitMeetingWorkPackage(ctx, db.LockCockpitMeetingWorkPackageParams{WorkspaceID: c.WorkspaceID, ID: c.MeetingID})
	if err != nil {
		return fail(cockpitWorkflowError(err))
	}
	return tx, q, minutesStateFromLock(c.WorkspaceID, work), nil
}
func cockpitWorkflowRevision(work cockpitMinutesState, expected int64) error {
	if expected < 1 {
		return fmt.Errorf("%w: expected_revision must be positive", ErrCockpitWorkflowInput)
	}
	if work.Revision != expected {
		return ErrCockpitWorkflowConflict
	}
	return nil
}

func GuardCockpitIssueExecution(ctx context.Context, q *db.Queries, issueID pgtype.UUID) error {
	if !issueID.Valid {
		return nil
	}
	if q == nil {
		return errors.New("meeting execution gate is unavailable")
	}
	blocked, err := q.CockpitIssueExecutionBlocked(ctx, issueID)
	if err != nil {
		return fmt.Errorf("meeting execution gate: %w", err)
	}
	if blocked {
		return ErrCockpitWorkflowExecutionBlocked
	}
	return nil
}

func (s *IssueService) EnableCockpitMeetingWorkPackage(ctx context.Context, p CockpitWorkPackageInit, opts IssueCreateOpts) error {
	if !p.ReviewerID.Valid {
		return fmt.Errorf("%w: a human reviewer is required", ErrCockpitWorkflowInput)
	}
	if !p.ExistingIssueID.Valid {
		create := p.NewIssue
		create.WorkspaceID = p.WorkspaceID
		create.Status = "backlog"
		create.CreatorType = "member"
		create.CreatorID = p.ActorID
		create.MeetingTask = nil
		create.CockpitWorkflow = &CockpitWorkflowIssue{Init: &p}
		create.AllowDuplicate = true
		if !create.AssigneeID.Valid {
			create.AssigneeType = pgtype.Text{String: "member", Valid: true}
			create.AssigneeID = p.ActorID
		}
		_, err := s.Create(ctx, create, opts)
		return err
	}
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := s.Queries.WithTx(tx)
	if err := cockpitWorkflowMember(ctx, q, p.WorkspaceID, p.ActorID); err != nil {
		return err
	}
	if err := cockpitWorkflowMember(ctx, q, p.WorkspaceID, p.ReviewerID); err != nil {
		return fmt.Errorf("%w: reviewer must be a workspace member", ErrCockpitWorkflowInput)
	}
	if _, err := lockCockpitWorkflowMeeting(ctx, q, p.WorkspaceID, p.MeetingID); err != nil {
		return err
	}
	existingRow, err := q.GetCockpitMeetingWorkPackage(ctx, db.GetCockpitMeetingWorkPackageParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID})
	if err != nil {
		return cockpitWorkflowError(err)
	}
	existing := minutesStateFromGet(p.WorkspaceID, existingRow)
	if existing.MinutesIssueID.Valid {
		if err := requireCockpitWorkflowManager(ctx, q, existing, p.ActorID); err != nil {
			return err
		}
		if existing.MinutesIssueID != p.ExistingIssueID || existing.ReviewerID != p.ReviewerID {
			return ErrCockpitWorkflowConflict
		}
		issue, err := q.LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{ID: existing.MinutesIssueID, WorkspaceID: p.WorkspaceID})
		if err != nil {
			return cockpitWorkflowError(err)
		}
		return validateCockpitWorkflowInitRetry(ctx, q, p, issue, nil)
	}
	if err := RequireCockpitMeetingPreparationOpen(ctx, q, p.WorkspaceID, p.MeetingID); err != nil {
		return err
	}
	issue, err := q.LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{ID: p.ExistingIssueID, WorkspaceID: p.WorkspaceID})
	if err != nil {
		return cockpitWorkflowError(err)
	}
	if issue.Status != "backlog" || issue.TriageState.Valid {
		return fmt.Errorf("%w: only an unstarted backlog issue can be adopted", ErrCockpitWorkflowConflict)
	}
	active, err := q.CockpitWorkflowIssueHasActiveTask(ctx, issue.ID)
	if err != nil {
		return err
	}
	if active {
		return fmt.Errorf("%w: issue has active runs", ErrCockpitWorkflowConflict)
	}
	linked, err := q.CockpitIssueHasWorkflow(ctx, issue.ID)
	if err != nil {
		return err
	}
	if linked {
		return fmt.Errorf("%w: issue already belongs to a work package", ErrCockpitWorkflowConflict)
	}
	if err := createCockpitWorkPackageForIssue(ctx, q, p, issue, existing.Revision); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func prepareCockpitWorkflowIssue(ctx context.Context, q *db.Queries, p *IssueCreateParams) (*db.Issue, error) {
	hook := p.CockpitWorkflow
	if hook.Handoff != nil {
		return prepareCockpitReviewerHandoffIssue(ctx, q, p)
	}
	if hook.Init != nil {
		in := *hook.Init
		if err := cockpitWorkflowMember(ctx, q, in.WorkspaceID, in.ActorID); err != nil {
			return nil, err
		}
		if err := cockpitWorkflowMember(ctx, q, in.WorkspaceID, in.ReviewerID); err != nil {
			return nil, fmt.Errorf("%w: reviewer must be a workspace member", ErrCockpitWorkflowInput)
		}
		if _, err := lockCockpitWorkflowMeeting(ctx, q, in.WorkspaceID, in.MeetingID); err != nil {
			return nil, err
		}
		existingRow, err := q.GetCockpitMeetingWorkPackage(ctx, db.GetCockpitMeetingWorkPackageParams{WorkspaceID: in.WorkspaceID, ID: in.MeetingID})
		if err != nil {
			return nil, cockpitWorkflowError(err)
		}
		existing := minutesStateFromGet(in.WorkspaceID, existingRow)
		hook.work = existing
		if existing.MinutesIssueID.Valid {
			if err := requireCockpitWorkflowManager(ctx, q, existing, in.ActorID); err != nil {
				return nil, err
			}
			if existing.ReviewerID != in.ReviewerID {
				return nil, ErrCockpitWorkflowConflict
			}
			issue, err := q.LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{ID: existing.MinutesIssueID, WorkspaceID: in.WorkspaceID})
			if err != nil {
				return nil, cockpitWorkflowError(err)
			}
			if err := validateCockpitWorkflowInitRetry(ctx, q, in, issue, p); err != nil {
				return nil, err
			}
			return &issue, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if err := RequireCockpitMeetingPreparationOpen(ctx, q, in.WorkspaceID, in.MeetingID); err != nil {
			return nil, err
		}
		return nil, nil
	}
	in := hook.Submission
	if in == nil {
		return nil, ErrCockpitWorkflowInput
	}
	meeting, err := lockCockpitWorkflowMeeting(ctx, q, in.WorkspaceID, in.MeetingID)
	if err != nil {
		return nil, err
	}
	work, err := q.LockCockpitMeetingWorkPackage(ctx, db.LockCockpitMeetingWorkPackageParams{WorkspaceID: in.WorkspaceID, ID: in.MeetingID})
	if err != nil {
		return nil, cockpitWorkflowError(err)
	}
	existing, err := q.GetCockpitMinutesSubmission(ctx, db.GetCockpitMinutesSubmissionParams{WorkspaceID: in.WorkspaceID, MeetingID: in.MeetingID, SubmissionKey: in.SubmissionKey})
	if err == nil {
		if existing.Content != in.Content || existing.SubmittedByType != in.ActorType || existing.SubmittedByID != in.AuthorID {
			return nil, ErrCockpitWorkflowConflict
		}
		issue, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: existing.ReviewIssueID, WorkspaceID: in.WorkspaceID})
		return &issue, cockpitWorkflowError(err)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	workState := minutesStateFromLock(in.WorkspaceID, work)
	if err := cockpitWorkflowRevision(workState, in.ExpectedRevision); err != nil {
		return nil, err
	}
	if workState.CurrentVersionID.Valid {
		current, err := q.GetCockpitMinutesVersion(ctx, db.GetCockpitMinutesVersionParams{WorkspaceID: in.WorkspaceID, MeetingID: in.MeetingID, ID: work.CurrentVersionID})
		if err != nil {
			return nil, err
		}
		if current.Decision == "pending" {
			return nil, fmt.Errorf("%w: complete the current review before submitting another version", ErrCockpitWorkflowConflict)
		}
	}
	if err := cockpitWorkflowMember(ctx, q, in.WorkspaceID, workState.ReviewerID); err != nil {
		return nil, fmt.Errorf("%w: reviewer is no longer a workspace member", ErrCockpitWorkflowConflict)
	}
	source, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: workState.MinutesIssueID, WorkspaceID: in.WorkspaceID})
	if err != nil {
		return nil, cockpitWorkflowError(err)
	}
	if in.ActorType == "member" && requireCockpitWorkflowManager(ctx, q, workState, in.ActorID) != nil && !(source.AssigneeType.String == "member" && source.AssigneeID == in.ActorID) {
		return nil, ErrCockpitWorkflowForbidden
	}
	hook.work = workState
	hook.versionID = dbid.NewV7()
	p.Title = "Review meeting minutes: " + meeting.Title
	p.Description = cockpitMinutesReviewDescription(hook.versionID, in.Content)
	p.Status = "todo"
	p.Priority = "none"
	p.ProjectID = source.ProjectID
	p.ModuleID = source.ModuleID
	p.AssigneeType = pgtype.Text{String: "member", Valid: true}
	p.AssigneeID = work.ReviewerID
	return nil, nil
}

func linkCockpitWorkflowPurpose(ctx context.Context, q *db.Queries, ws, meeting, issue pgtype.UUID, purpose string) error {
	link, err := q.GetCockpitMeetingIssue(ctx, db.GetCockpitMeetingIssueParams{WorkspaceID: ws, MeetingID: meeting, IssueID: issue})
	if errors.Is(err, pgx.ErrNoRows) {
		link, err = q.CreateCockpitMeetingIssue(ctx, db.CreateCockpitMeetingIssueParams{WorkspaceID: ws, MeetingID: meeting, IssueID: issue})
	}
	if err != nil {
		return err
	}
	roles := append([]string{}, link.Roles...)
	found := false
	for _, r := range roles {
		if r == purpose {
			found = true
		}
	}
	if !found {
		roles = append(roles, purpose)
	}
	_, err = q.UpdateCockpitMeetingIssueRoles(ctx, db.UpdateCockpitMeetingIssueRolesParams{WorkspaceID: ws, MeetingID: meeting, IssueID: issue, Roles: roles})
	return err
}
func createCockpitWorkPackageForIssue(ctx context.Context, q *db.Queries, in CockpitWorkPackageInit, issue db.Issue, revision int64) error {
	if _, err := q.AttachCockpitMinutesIssueLink(ctx, db.AttachCockpitMinutesIssueLinkParams{WorkspaceID: in.WorkspaceID, MeetingID: in.MeetingID, IssueID: issue.ID}); err != nil {
		return err
	}
	if _, err := q.SetCockpitMinutesSetup(ctx, db.SetCockpitMinutesSetupParams{WorkspaceID: in.WorkspaceID, MeetingID: in.MeetingID, FocusIssueID: issue.ID, ReviewerID: in.ReviewerID, ActorID: in.ActorID, ExpectedRevision: revision}); err != nil {
		return err
	}
	if in.NodeID.Valid {
		node, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{ID: in.NodeID, WorkspaceID: in.WorkspaceID})
		if err != nil {
			return fmt.Errorf("%w: archive node not found", ErrCockpitWorkflowInput)
		}
		meeting, err := q.GetCockpitMeeting(ctx, db.GetCockpitMeetingParams{ID: in.MeetingID, WorkspaceID: in.WorkspaceID})
		if err != nil {
			return err
		}
		if node.CockpitID != meeting.CockpitID {
			return ErrCockpitWorkflowInput
		}
		if err := validateCockpitWorkflowArchiveScope(ctx, q, node, issue); err != nil {
			return err
		}
		if _, err = q.CreateCockpitNodeIssue(ctx, db.CreateCockpitNodeIssueParams{WorkspaceID: in.WorkspaceID, NodeID: node.ID, IssueID: issue.ID}); err != nil {
			return err
		}
	}
	return linkCockpitWorkflowPurpose(ctx, q, in.WorkspaceID, in.MeetingID, issue.ID, "minutes")
}
func linkCockpitWorkflowCreatedIssue(ctx context.Context, q *db.Queries, p IssueCreateParams, issue db.Issue) error {
	hook := p.CockpitWorkflow
	if hook.Handoff != nil {
		return linkCockpitReviewerHandoffIssue(ctx, q, p, issue)
	}
	if hook.Init != nil {
		return createCockpitWorkPackageForIssue(ctx, q, *hook.Init, issue, hook.work.Revision)
	}
	in := hook.Submission
	version, err := q.CreateCockpitMinutesVersion(ctx, db.CreateCockpitMinutesVersionParams{
		ID: hook.versionID, WorkspaceID: in.WorkspaceID, MeetingID: in.MeetingID, SubmissionKey: in.SubmissionKey,
		Content: in.Content, ContentHash: fmt.Sprintf("%x", sha256.Sum256([]byte(in.Content))), SourceIssueID: hook.work.MinutesIssueID,
		ReviewIssueID: issue.ID, ReviewerID: hook.work.ReviewerID, SubmittedByType: in.ActorType, SubmittedByID: in.AuthorID,
	})
	if err != nil {
		return err
	}
	if _, err = q.SetCockpitCurrentMinutesVersion(ctx, db.SetCockpitCurrentMinutesVersionParams{WorkspaceID: in.WorkspaceID, ID: in.MeetingID, MinutesCurrentVersionID: version.ID, MinutesRevision: hook.work.Revision}); err != nil {
		return cockpitWorkflowError(err)
	}
	return linkCockpitWorkflowPurpose(ctx, q, in.WorkspaceID, in.MeetingID, issue.ID, "review")
}

func (s *IssueService) SetCockpitMeetingReadiness(ctx context.Context, p CockpitWorkPackageReadiness) error {
	tx, q, work, err := s.beginCockpitWorkflow(ctx, p.CockpitWorkPackageCommand)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := requireCockpitWorkflowManager(ctx, q, work, p.ActorID); err != nil {
		return err
	}
	meeting, err := q.GetCockpitMeetingLifecycle(ctx, db.GetCockpitMeetingLifecycleParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID})
	if err != nil {
		return cockpitWorkflowError(err)
	}
	if meeting.OccurrenceState == "cancelled" {
		return fmt.Errorf("%w: reschedule this cancelled meeting before changing readiness", ErrCockpitWorkflowConflict)
	}
	if p.Ended != nil && !*p.Ended && meeting.EndedAt.Valid {
		return fmt.Errorf("%w: an ended meeting cannot be reopened here", ErrCockpitWorkflowInput)
	}
	if p.Ended == nil && p.MaterialsReady == nil {
		return ErrCockpitWorkflowInput
	}
	same := (p.Ended == nil || *p.Ended == meeting.EndedAt.Valid) && (p.MaterialsReady == nil || *p.MaterialsReady == work.MaterialsReady)
	if same {
		return nil
	}
	if err := cockpitWorkflowRevision(work, p.ExpectedRevision); err != nil {
		return err
	}
	ready := pgtype.Bool{}
	if p.MaterialsReady != nil {
		ready = pgtype.Bool{Bool: *p.MaterialsReady, Valid: true}
	}
	if p.Ended != nil && *p.Ended && !meeting.EndedAt.Valid {
		_, err = applyMeetingOccurrence(ctx, q, CockpitLifecycleRead{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ActorID: p.ActorID, Human: true}, meeting, CockpitOccurrenceInput{CockpitLifecycleCommandInput: CockpitLifecycleCommandInput{ExpectedRevision: meeting.LifecycleRevision}, Transition: "end"})
		if err != nil {
			return err
		}
	}
	_, err = q.SetCockpitMeetingReadiness(ctx, db.SetCockpitMeetingReadinessParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID, ActorID: p.ActorID, MaterialsReady: ready, ExpectedRevision: p.ExpectedRevision})
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *IssueService) SubmitCockpitMeetingMinutes(ctx context.Context, p CockpitMinutesSubmission, opts IssueCreateOpts) error {
	if !p.SubmissionKey.Valid || strings.TrimSpace(p.Content) == "" || len(p.Content) > 128*1024 {
		return fmt.Errorf("%w: submission requires a UUID key and 1–131072 bytes of text", ErrCockpitWorkflowInput)
	}
	if err := cockpitWorkflowMember(ctx, s.Queries, p.WorkspaceID, p.ActorID); err != nil {
		return err
	}
	if !p.AuthorID.Valid && p.ActorType == "member" {
		p.AuthorID = p.ActorID
	}
	if p.ActorType == "member" {
		if p.AuthorID != p.ActorID {
			return ErrCockpitWorkflowForbidden
		}
		if err := cockpitWorkflowMember(ctx, s.Queries, p.WorkspaceID, p.ActorID); err != nil {
			return err
		}
	} else if p.ActorType == "agent" {
		if _, err := s.Queries.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{ID: p.AuthorID, WorkspaceID: p.WorkspaceID}); err != nil {
			return ErrCockpitWorkflowForbidden
		}
	} else {
		return ErrCockpitWorkflowForbidden
	}
	_, err := s.Create(ctx, IssueCreateParams{WorkspaceID: p.WorkspaceID, CreatorType: p.ActorType, CreatorID: p.AuthorID, AllowDuplicate: true, CockpitWorkflow: &CockpitWorkflowIssue{Submission: &p}}, opts)
	return err
}

func (s *IssueService) ReviewCockpitMeetingMinutes(ctx context.Context, p CockpitMinutesReview) error {
	if p.Decision != "approved" && p.Decision != "changes_requested" && p.Decision != "rejected" {
		return ErrCockpitWorkflowInput
	}
	p.Feedback = strings.TrimSpace(p.Feedback)
	if p.Decision != "approved" && p.Feedback == "" {
		return fmt.Errorf("%w: feedback is required", ErrCockpitWorkflowInput)
	}
	if len(p.Feedback) > 16000 {
		return ErrCockpitWorkflowInput
	}
	tx, q, work, err := s.beginCockpitWorkflow(ctx, p.CockpitWorkPackageCommand)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	version, err := q.GetCockpitMinutesVersion(ctx, db.GetCockpitMinutesVersionParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.VersionID})
	if err != nil {
		return cockpitWorkflowError(err)
	}
	if version.ReviewerID != p.ActorID {
		return ErrCockpitWorkflowForbidden
	}
	if version.Decision == p.Decision && version.Feedback == p.Feedback && version.ReviewedBy == p.ActorID {
		return nil
	}
	if err := cockpitWorkflowRevision(work, p.ExpectedRevision); err != nil {
		return err
	}
	if work.CurrentVersionID != p.VersionID || version.Decision != "pending" {
		return ErrCockpitWorkflowConflict
	}
	lockIDs := []pgtype.UUID{version.ReviewIssueID}
	if p.Decision == "changes_requested" {
		lockIDs = append(lockIDs, work.MinutesIssueID)
	}
	if len(lockIDs) == 2 && util.UUIDToString(lockIDs[0]) > util.UUIDToString(lockIDs[1]) {
		lockIDs[0], lockIDs[1] = lockIDs[1], lockIDs[0]
	}
	previousStatuses := map[pgtype.UUID]string{}
	for _, id := range lockIDs {
		current, lockErr := q.LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{ID: id, WorkspaceID: p.WorkspaceID})
		if lockErr != nil {
			return cockpitWorkflowError(lockErr)
		}
		previousStatuses[id] = current.Status
	}
	if _, err = q.ReviewCockpitMinutesVersion(ctx, db.ReviewCockpitMinutesVersionParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.VersionID, Decision: p.Decision, Feedback: p.Feedback, ReviewedBy: p.ActorID}); err != nil {
		return err
	}
	if _, err = q.AdvanceCockpitWorkflowRevision(ctx, db.AdvanceCockpitWorkflowRevisionParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID, MinutesRevision: p.ExpectedRevision}); err != nil {
		return err
	}
	issue, err := q.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{ID: version.ReviewIssueID, WorkspaceID: p.WorkspaceID, Status: "done"})
	if err != nil {
		return cockpitWorkflowError(err)
	}
	cancelled, err := StopClosedIssueWakeups(ctx, q, issue)
	if err != nil {
		return err
	}
	var rework db.Issue
	if p.Decision == "changes_requested" {
		rework, err = q.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{ID: work.MinutesIssueID, WorkspaceID: p.WorkspaceID, Status: "todo"})
		if err != nil {
			return err
		}
		if _, err = StopClosedIssueWakeups(ctx, q, rework); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.publishCockpitWorkflowIssueUpdate(ctx, issue, p.ActorID, previousStatuses[issue.ID])
	if rework.ID.Valid {
		s.publishCockpitWorkflowIssueUpdate(ctx, rework, p.ActorID, previousStatuses[rework.ID])
	}
	if s.TaskService != nil {
		for _, task := range cancelled {
			s.TaskService.broadcastTaskEvent(ctx, protocol.EventTaskCancelled, task)
		}
	}
	return nil
}
func (s *IssueService) PublishCockpitMeetingMinutes(ctx context.Context, p CockpitMinutesVersionCommand) error {
	tx, q, work, err := s.beginCockpitWorkflow(ctx, p.CockpitWorkPackageCommand)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	version, err := q.GetCockpitMinutesVersion(ctx, db.GetCockpitMinutesVersionParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.VersionID})
	if err != nil {
		return cockpitWorkflowError(err)
	}
	if version.ReviewerID != p.ActorID && requireCockpitWorkflowManager(ctx, q, work, p.ActorID) != nil {
		return ErrCockpitWorkflowForbidden
	}
	if work.PublishedVersionID == p.VersionID && version.PublishedAt.Valid {
		if p.NASExport == nil {
			return nil
		}
		if _, err = s.enqueueCockpitMinutesExport(ctx, q, version, p.ActorID, *p.NASExport); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	if err := cockpitWorkflowRevision(work, p.ExpectedRevision); err != nil {
		return err
	}
	if work.CurrentVersionID != p.VersionID || version.Decision != "approved" {
		return fmt.Errorf("%w: only the approved current version can be published", ErrCockpitWorkflowConflict)
	}
	if _, err = q.PublishCockpitMinutesVersion(ctx, db.PublishCockpitMinutesVersionParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.VersionID, PublishedBy: p.ActorID}); err != nil {
		return err
	}
	if _, err = q.SetCockpitPublishedMinutesVersion(ctx, db.SetCockpitPublishedMinutesVersionParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID, MinutesPublishedVersionID: p.VersionID, MinutesRevision: p.ExpectedRevision}); err != nil {
		return err
	}
	if p.NASExport != nil {
		// Resolve is pure configuration/path validation. Filesystem work only
		// starts after this publication and its intent commit together.
		if _, err = s.enqueueCockpitMinutesExport(ctx, q, version, p.ActorID, *p.NASExport); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
func (s *IssueService) UnpublishCockpitMeetingMinutes(ctx context.Context, p CockpitMinutesUnpublish) error {
	p.Reason = strings.TrimSpace(p.Reason)
	if p.Reason == "" {
		return fmt.Errorf("%w: unpublished_reason is required", ErrCockpitWorkflowInput)
	}
	if len(p.Reason) > 16000 {
		return fmt.Errorf("%w: unpublished_reason exceeds 16000 bytes", ErrCockpitWorkflowInput)
	}
	tx, q, work, err := s.beginCockpitWorkflow(ctx, p.CockpitWorkPackageCommand)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := requireCockpitWorkflowManager(ctx, q, work, p.ActorID); err != nil {
		return err
	}
	version, err := q.GetCockpitMinutesVersion(ctx, db.GetCockpitMinutesVersionParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.VersionID})
	if err != nil {
		return cockpitWorkflowError(err)
	}
	if version.UnpublishedAt.Valid && work.PublishedVersionID != p.VersionID {
		// Retry after a completed withdrawal: the pointer already moved off
		// this version, so the command's outcome has been reached.
		return nil
	}
	if err := cockpitWorkflowRevision(work, p.ExpectedRevision); err != nil {
		return err
	}
	if work.PublishedVersionID != p.VersionID || !version.PublishedAt.Valid || version.UnpublishedAt.Valid {
		return fmt.Errorf("%w: only the currently published version can be unpublished", ErrCockpitWorkflowConflict)
	}
	// Unpublish writes the withdrawal audit on the version, keeping its
	// publication history; written NAS copies and retained files stay as they
	// are (design-principles-2026-10-12 principle 2).
	if _, err = q.UnpublishCockpitMinutesVersion(ctx, db.UnpublishCockpitMinutesVersionParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.VersionID,
		UnpublishedBy: p.ActorID, UnpublishedReason: pgtype.Text{String: p.Reason, Valid: true}}); err != nil {
		return err
	}
	if _, err = q.ClearCockpitPublishedMinutesVersion(ctx, db.ClearCockpitPublishedMinutesVersionParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID,
		MinutesPublishedVersionID: p.VersionID, MinutesRevision: p.ExpectedRevision}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *IssueService) publishCockpitWorkflowIssueUpdate(ctx context.Context, issue db.Issue, actor pgtype.UUID, previousStatus string) {
	if s.Bus == nil {
		return
	}
	workspace, err := s.Queries.GetWorkspace(ctx, issue.WorkspaceID)
	if err != nil {
		return
	}
	s.Bus.Publish(events.Event{Type: protocol.EventIssueUpdated, WorkspaceID: util.UUIDToString(issue.WorkspaceID), ActorType: "member", ActorID: util.UUIDToString(actor), Payload: map[string]any{"issue": IssueToMapResolved(ctx, s.Queries, issue, workspace.IssuePrefix), "status_changed": issue.Status != previousStatus, "prev_status": previousStatus}})
}

func requireCockpitWorkflowManager(ctx context.Context, q *db.Queries, work cockpitMinutesState, actor pgtype.UUID) error {
	member, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: actor, WorkspaceID: work.WorkspaceID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrCockpitWorkflowForbidden
		}
		return err
	}
	if work.ConfiguredBy == actor || member.Role == "owner" || member.Role == "admin" {
		return nil
	}
	return ErrCockpitWorkflowForbidden
}

// Archive links do not refile issues. Explicit ancestor UUID bindings constrain
// the destination; an entirely unbound historical archive remains a reference.
func validateCockpitWorkflowArchiveScope(ctx context.Context, q *db.Queries, node db.CockpitNode, issue db.Issue) error {
	nodes, err := q.ListCockpitNodes(ctx, node.CockpitID)
	if err != nil {
		return err
	}
	byID := make(map[pgtype.UUID]db.CockpitNode, len(nodes))
	for _, n := range nodes {
		byID[n.ID] = n
	}
	seen := map[pgtype.UUID]bool{}
	var project, module pgtype.UUID
	for {
		if seen[node.ID] {
			return fmt.Errorf("%w: archive node ancestry contains a cycle", ErrCockpitWorkflowInput)
		}
		seen[node.ID] = true
		if node.ProjectID.Valid || node.ModuleID.Valid {
			if !node.ProjectID.Valid {
				return fmt.Errorf("%w: archive binding is incomplete", ErrCockpitWorkflowInput)
			}
			if project.Valid && project != node.ProjectID {
				return fmt.Errorf("%w: archive binding has conflicting ancestors", ErrCockpitWorkflowInput)
			}
			if node.ModuleID.Valid && project.Valid {
				return fmt.Errorf("%w: archive binding is nested below a module", ErrCockpitWorkflowInput)
			}
			if !project.Valid {
				project, module = node.ProjectID, node.ModuleID
			}
		}
		if !node.ParentID.Valid {
			break
		}
		parent, ok := byID[node.ParentID]
		if !ok {
			return fmt.Errorf("%w: archive node ancestor is missing", ErrCockpitWorkflowInput)
		}
		node = parent
	}
	if project.Valid && project != issue.ProjectID {
		return fmt.Errorf("%w: archive node project does not match the issue", ErrCockpitWorkflowInput)
	}
	if module.Valid && module != issue.ModuleID {
		return fmt.Errorf("%w: archive node module does not match the issue", ErrCockpitWorkflowInput)
	}
	return nil
}

func isCockpitExecutionGateFailure(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.ConstraintName == "cockpit_workflow_execution_gate"
}

// Initialization is a retry only when its effective destination and executor
// match the existing work. It never silently reassigns work or adds an archive
// reference after a competing initialization has already committed.
func validateCockpitWorkflowInitRetry(ctx context.Context, q *db.Queries, in CockpitWorkPackageInit, issue db.Issue, create *IssueCreateParams) error {
	conflict := func(detail string) error {
		return fmt.Errorf("%w: existing work package %s", ErrCockpitWorkflowConflict, detail)
	}
	if create != nil {
		if create.AssigneeType != issue.AssigneeType || create.AssigneeID != issue.AssigneeID {
			return conflict("has a different executor")
		}
		if create.ModuleID != issue.ModuleID {
			return conflict("has a different module")
		}
		project := create.ProjectID
		if create.ModuleID.Valid {
			module, err := q.GetModuleInWorkspace(ctx, db.GetModuleInWorkspaceParams{ID: create.ModuleID, WorkspaceID: in.WorkspaceID})
			if errors.Is(err, pgx.ErrNoRows) {
				return conflict("module no longer exists")
			}
			if err != nil {
				return err
			}
			if project.Valid && project != module.ProjectID {
				return conflict("has a different project")
			}
			project = module.ProjectID
		}
		if project != issue.ProjectID {
			return conflict("has a different project")
		}
	}
	if !in.NodeID.Valid {
		return nil
	}
	node, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{ID: in.NodeID, WorkspaceID: in.WorkspaceID})
	if errors.Is(err, pgx.ErrNoRows) {
		return conflict("archive node no longer exists")
	}
	if err != nil {
		return err
	}
	meeting, err := q.GetCockpitMeeting(ctx, db.GetCockpitMeetingParams{ID: in.MeetingID, WorkspaceID: in.WorkspaceID})
	if err != nil {
		return cockpitWorkflowError(err)
	}
	if node.CockpitID != meeting.CockpitID {
		return conflict("has a different archive board")
	}
	if err := validateCockpitWorkflowArchiveScope(ctx, q, node, issue); err != nil {
		if errors.Is(err, ErrCockpitWorkflowInput) {
			return conflict("archive scope no longer matches its issue")
		}
		return err
	}
	links, err := q.ListCockpitNodeIssues(ctx, node.CockpitID)
	if err != nil {
		return err
	}
	for _, link := range links {
		if link.NodeID == node.ID && link.IssueID == issue.ID {
			return nil
		}
	}
	return conflict("does not have the requested archive link")
}

func cockpitMinutesReviewDescription(versionID pgtype.UUID, content string) pgtype.Text {
	return pgtype.Text{String: "Review the fixed version " + util.UUIDToString(versionID) + " in the meeting workflow. Completing this issue does not approve or publish it.\n\n" + content, Valid: true}
}
