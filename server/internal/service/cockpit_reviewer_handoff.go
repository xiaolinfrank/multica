package service

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

type CockpitReviewerHandoff struct {
	CockpitWorkPackageCommand
	HandoffKey, ReviewerID pgtype.UUID
	Reason                 string
}

// A replay may refer to a default-only change that created no Issue. Returning
// this internal sentinel from the create hook rolls back its read-only tx and
// avoids inventing an Issue result or repeating any post-create side effects.
var errCockpitHandoffReplayed = errors.New("reviewer handoff already applied")

func sameCockpitReviewerHandoff(existing db.CockpitReviewerHandoff, p CockpitReviewerHandoff) error {
	if existing.CreatedBy != p.ActorID || existing.ToReviewerID != p.ReviewerID || existing.Reason != p.Reason || existing.Revision != p.ExpectedRevision+1 {
		return fmt.Errorf("%w: handoff key was already used for another command", ErrCockpitWorkflowConflict)
	}
	return nil
}

func checkCockpitReviewerHandoff(ctx context.Context, q *db.Queries, work db.CockpitMeetingWorkPackage, p CockpitReviewerHandoff) (bool, error) {
	if err := requireCockpitWorkflowManager(ctx, q, work, p.ActorID); err != nil {
		return false, err
	}
	prior, err := q.GetCockpitReviewerHandoff(ctx, db.GetCockpitReviewerHandoffParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, HandoffKey: p.HandoffKey})
	if err == nil {
		return true, sameCockpitReviewerHandoff(prior, p)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	if err := cockpitWorkflowRevision(work, p.ExpectedRevision); err != nil {
		return false, err
	}
	if work.ReviewerID == p.ReviewerID {
		return false, fmt.Errorf("%w: choose a different reviewer", ErrCockpitWorkflowInput)
	}
	if err := cockpitWorkflowMember(ctx, q, p.WorkspaceID, p.ReviewerID); err != nil {
		if errors.Is(err, ErrCockpitWorkflowForbidden) {
			return false, fmt.Errorf("%w: reviewer must be a current workspace member", ErrCockpitWorkflowInput)
		}
		return false, err
	}
	return false, nil
}

func (s *IssueService) ChangeCockpitMeetingReviewer(ctx context.Context, p CockpitReviewerHandoff, opts IssueCreateOpts) error {
	p.Reason = strings.TrimSpace(p.Reason)
	if !p.HandoffKey.Valid || !p.ReviewerID.Valid || p.ExpectedRevision < 1 || p.Reason == "" || len(p.Reason) > 16000 {
		return fmt.Errorf("%w: handoff requires UUID key, reviewer, positive revision and 1–16000 bytes of reason", ErrCockpitWorkflowInput)
	}
	initial, err := s.Queries.GetCockpitMeetingWorkPackage(ctx, db.GetCockpitMeetingWorkPackageParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID})
	if err != nil {
		return cockpitWorkflowError(err)
	}
	if err := requireCockpitWorkflowManager(ctx, s.Queries, initial, p.ActorID); err != nil {
		return err
	}
	prior, err := s.Queries.GetCockpitReviewerHandoff(ctx, db.GetCockpitReviewerHandoffParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, HandoffKey: p.HandoffKey})
	if err == nil {
		return sameCockpitReviewerHandoff(prior, p)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	pending := false
	if initial.CurrentVersionID.Valid {
		version, err := s.Queries.GetCockpitMinutesVersion(ctx, db.GetCockpitMinutesVersionParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: initial.CurrentVersionID})
		if err != nil {
			return cockpitWorkflowError(err)
		}
		pending = version.Decision == "pending"
	}
	if pending {
		_, err := s.Create(ctx, IssueCreateParams{WorkspaceID: p.WorkspaceID, CreatorType: "member", CreatorID: p.ActorID, AllowDuplicate: true, CockpitWorkflow: &CockpitWorkflowIssue{Handoff: &p}}, opts)
		if errors.Is(err, errCockpitHandoffReplayed) {
			return nil
		}
		return err
	}
	tx, q, work, err := s.beginCockpitWorkflow(ctx, p.CockpitWorkPackageCommand)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	replay, err := checkCockpitReviewerHandoff(ctx, q, work, p)
	if err != nil || replay {
		return err
	}
	// The pre-read only chooses an implementation branch. Recheck after locking;
	// a newly submitted pending version must never lose its reviewer silently.
	if work.CurrentVersionID.Valid {
		version, err := q.GetCockpitMinutesVersion(ctx, db.GetCockpitMinutesVersionParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: work.CurrentVersionID})
		if err != nil {
			return err
		}
		if version.Decision == "pending" {
			return ErrCockpitWorkflowConflict
		}
	}
	updated, err := q.SetCockpitDefaultReviewer(ctx, db.SetCockpitDefaultReviewerParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ReviewerID: p.ReviewerID, Revision: p.ExpectedRevision})
	if err != nil {
		return err
	}
	if _, err := q.CreateCockpitReviewerHandoff(ctx, db.CreateCockpitReviewerHandoffParams{ID: dbid.NewV7(), WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, HandoffKey: p.HandoffKey, FromReviewerID: work.ReviewerID, ToReviewerID: p.ReviewerID, Reason: p.Reason, CreatedBy: p.ActorID, Revision: updated.Revision}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func prepareCockpitReviewerHandoffIssue(ctx context.Context, q *db.Queries, p *IssueCreateParams) (*db.Issue, error) {
	hook := p.CockpitWorkflow
	in := *hook.Handoff
	meeting, err := lockCockpitWorkflowMeeting(ctx, q, in.WorkspaceID, in.MeetingID)
	if err != nil {
		return nil, err
	}
	work, err := q.LockCockpitMeetingWorkPackage(ctx, db.LockCockpitMeetingWorkPackageParams{WorkspaceID: in.WorkspaceID, MeetingID: in.MeetingID})
	if err != nil {
		return nil, cockpitWorkflowError(err)
	}
	replay, err := checkCockpitReviewerHandoff(ctx, q, work, in)
	if err != nil {
		return nil, err
	}
	if replay {
		return nil, errCockpitHandoffReplayed
	}
	if !work.CurrentVersionID.Valid {
		return nil, ErrCockpitWorkflowConflict
	}
	version, err := q.GetCockpitMinutesVersion(ctx, db.GetCockpitMinutesVersionParams{WorkspaceID: in.WorkspaceID, MeetingID: in.MeetingID, ID: work.CurrentVersionID})
	if err != nil {
		return nil, err
	}
	if version.Decision != "pending" || version.ReviewerID != work.ReviewerID {
		return nil, ErrCockpitWorkflowConflict
	}
	ids := []pgtype.UUID{work.MinutesIssueID, version.ReviewIssueID}
	if util.UUIDToString(ids[0]) > util.UUIDToString(ids[1]) {
		ids[0], ids[1] = ids[1], ids[0]
	}
	var source db.Issue
	for _, id := range ids {
		issue, err := q.LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{WorkspaceID: in.WorkspaceID, ID: id})
		if err != nil {
			return nil, cockpitWorkflowError(err)
		}
		if id == work.MinutesIssueID {
			source = issue
		} else {
			hook.handoffPreviousStatus = issue.Status
		}
	}
	if err := q.SetCockpitWorkflowActor(ctx, in.ActorID); err != nil {
		return nil, err
	}
	hook.work = work
	hook.handoffVersion = version
	p.WorkspaceID = in.WorkspaceID
	p.CreatorType = "member"
	p.CreatorID = in.ActorID
	p.Title = "Review meeting minutes: " + meeting.Title
	p.Description = cockpitMinutesReviewDescription(version.ID, version.Content)
	p.Status = "todo"
	p.Priority = "none"
	p.ProjectID = source.ProjectID
	p.ModuleID = source.ModuleID
	p.AssigneeType = pgtype.Text{String: "member", Valid: true}
	p.AssigneeID = in.ReviewerID
	return nil, nil
}

func linkCockpitReviewerHandoffIssue(ctx context.Context, q *db.Queries, p IssueCreateParams, issue db.Issue) error {
	hook := p.CockpitWorkflow
	in := *hook.Handoff
	version := hook.handoffVersion
	updated, err := q.SetCockpitDefaultReviewer(ctx, db.SetCockpitDefaultReviewerParams{WorkspaceID: in.WorkspaceID, MeetingID: in.MeetingID, ReviewerID: in.ReviewerID, Revision: in.ExpectedRevision})
	if err != nil {
		return err
	}
	if _, err := q.CreateCockpitReviewerHandoff(ctx, db.CreateCockpitReviewerHandoffParams{
		ID: dbid.NewV7(), WorkspaceID: in.WorkspaceID, MeetingID: in.MeetingID, HandoffKey: in.HandoffKey,
		FromReviewerID: hook.work.ReviewerID, ToReviewerID: in.ReviewerID, VersionID: version.ID,
		FromReviewIssueID: version.ReviewIssueID, ToReviewIssueID: issue.ID, Reason: in.Reason, CreatedBy: in.ActorID, Revision: updated.Revision,
	}); err != nil {
		return err
	}
	if _, err := q.TransferCockpitPendingReview(ctx, db.TransferCockpitPendingReviewParams{
		WorkspaceID: in.WorkspaceID, MeetingID: in.MeetingID, VersionID: version.ID,
		ReviewerID: in.ReviewerID, ReviewIssueID: issue.ID, PreviousReviewerID: version.ReviewerID, PreviousReviewIssueID: version.ReviewIssueID,
	}); err != nil {
		return err
	}
	retired, err := q.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{WorkspaceID: in.WorkspaceID, ID: version.ReviewIssueID, Status: "cancelled"})
	if err != nil {
		return err
	}
	cancelled, err := StopClosedIssueWakeups(ctx, q, retired)
	if err != nil {
		return err
	}
	hook.handoffRetiredIssue = retired
	hook.handoffCancelledWakeups = cancelled
	return linkCockpitWorkflowPurpose(ctx, q, in.WorkspaceID, in.MeetingID, issue.ID, "review")
}

func (s *IssueService) finalizeCockpitReviewerHandoff(ctx context.Context, hook *CockpitWorkflowIssue) {
	in := hook.Handoff
	s.publishCockpitWorkflowIssueUpdate(ctx, hook.handoffRetiredIssue, in.ActorID, hook.handoffPreviousStatus)
	if s.TaskService != nil {
		s.TaskService.FinalizeIssueTaskCancellations(ctx, util.UUIDToString(in.WorkspaceID), hook.handoffCancelledWakeups)
	}
}
