package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func lifecycleArchive(m db.GetCockpitMeetingLifecycleRow) CockpitMeetingArchiveView {
	return CockpitMeetingArchiveView{ArchivedAt: lifecycleTime(m.ArchivedAt), ArchivedBy: planningUUID(m.ArchivedBy), Reason: m.ArchivedReason}
}

// This gate covers new preparation; existing work and formal decisions retain
// their own authorization and are not made read-only by archival.
func requireMeetingPreparationOpen(m db.GetCockpitMeetingLifecycleRow) error {
	if m.OccurrenceState == "cancelled" {
		return fmt.Errorf("%w: reschedule this cancelled meeting before adding preparation", ErrCockpitWorkflowConflict)
	}
	if m.ArchivedAt.Valid {
		return fmt.Errorf("%w: unarchive this meeting before adding preparation", ErrCockpitWorkflowConflict)
	}
	return nil
}

func RequireCockpitMeetingPreparationOpen(ctx context.Context, q *db.Queries, workspace, meeting pgtype.UUID) error {
	m, e := q.GetCockpitMeetingLifecycle(ctx, db.GetCockpitMeetingLifecycleParams{WorkspaceID: workspace, ID: meeting})
	if e != nil {
		return cockpitWorkflowError(e)
	}
	return requireMeetingPreparationOpen(m)
}

func (s *IssueService) ChangeCockpitMeetingDisposition(ctx context.Context, p CockpitLifecycleRead, in CockpitMeetingDispositionInput) (CockpitLifecycleCommandResult, error) {
	in.Reason = strings.TrimSpace(in.Reason)
	if in.Reason == "" || !templateText(in.Reason, 16000) {
		return CockpitLifecycleCommandResult{}, ErrCockpitWorkflowInput
	}
	switch in.Transition {
	case "reinstate", "archive", "unarchive":
	default:
		return CockpitLifecycleCommandResult{}, ErrCockpitWorkflowInput
	}
	c, e := newLifecycleCommand(p, in.CockpitLifecycleCommandInput, in.Transition, pgtype.UUID{}, pgtype.UUID{}, in)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	tx, q, x, old, e := s.beginLifecycleWrite(ctx, c)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	defer tx.Rollback(ctx)
	if old != nil {
		return *old, nil
	}
	if !lifecycleManager(ctx, q, x, p) {
		return CockpitLifecycleCommandResult{}, ErrCockpitWorkflowForbidden
	}
	m := x.meeting
	if m.LifecycleRevision != in.ExpectedRevision {
		return CockpitLifecycleCommandResult{}, ErrCockpitWorkflowConflict
	}
	previousOccurrence := lifecycleOccurrence(m)
	previousArchive := lifecycleArchive(m)
	switch in.Transition {
	case "reinstate":
		if m.OccurrenceState != "cancelled" {
			return CockpitLifecycleCommandResult{}, ErrCockpitWorkflowConflict
		}
		m.OccurrenceState = "scheduled"
		m.CancelledAt = pgtype.Timestamptz{}
		m.CancelledBy = pgtype.UUID{}
		m.CancelledReason = ""
	case "archive":
		if m.ArchivedAt.Valid {
			return CockpitLifecycleCommandResult{}, ErrCockpitWorkflowConflict
		}
		m.ArchivedAt = m.DatabaseNow
		m.ArchivedBy = p.ActorID
		m.ArchivedReason = in.Reason
	case "unarchive":
		if !m.ArchivedAt.Valid {
			return CockpitLifecycleCommandResult{}, ErrCockpitWorkflowConflict
		}
		m.ArchivedAt = pgtype.Timestamptz{}
		m.ArchivedBy = pgtype.UUID{}
		m.ArchivedReason = ""
	}
	rev, e := q.SetCockpitMeetingDisposition(ctx, db.SetCockpitMeetingDispositionParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ExpectedRevision: in.ExpectedRevision, ActorID: p.ActorID, State: m.OccurrenceState, CancelledAt: m.CancelledAt, CancelledBy: m.CancelledBy, CancelledReason: m.CancelledReason, ArchivedAt: m.ArchivedAt, ArchivedBy: m.ArchivedBy, ArchivedReason: m.ArchivedReason})
	if e != nil {
		return CockpitLifecycleCommandResult{}, cockpitWorkflowError(e)
	}
	occurrence := lifecycleOccurrence(m)
	archive := lifecycleArchive(m)
	return s.finishLifecycleWrite(ctx, tx, q, c, CockpitLifecycleReceipt{Revision: rev, AgendaRevision: m.AgendaRevision, Reason: in.Reason, PreviousOccurrence: &previousOccurrence, Occurrence: &occurrence, PreviousArchive: &previousArchive, Archive: &archive})
}

func (s *IssueService) GetCockpitMeetingOperationBasis(ctx context.Context, p CockpitLifecycleRead) (CockpitMeetingOperationBasis, error) {
	var out CockpitMeetingOperationBasis
	tx, q, x, e := s.beginLifecycleRead(ctx, p)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	allow := operationField("allowed")
	manager := lifecycleManager(ctx, q, x, p)
	out = CockpitMeetingOperationBasis{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), SchemaVersion: 1, GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano), Availability: "available", LifecycleRevision: &x.meeting.LifecycleRevision,
		Delete: allow, Cancel: allow, AppendDisposition: allow, Reinstate: allow, Archive: allow, Unarchive: allow, AddPreparation: allow, ApplyTemplate: allow, CanAddPreparation: p.Human, Targets: []IssueOperationTarget{}}
	if !p.Human {
		out.Delete = operationField("blocked", "human_required")
		out.AddPreparation = operationField("blocked", "human_required")
		out.ApplyTemplate = out.AddPreparation
	}
	if !manager {
		denied := operationField("blocked", "workflow_manager_required")
		out.Cancel = denied
		out.AppendDisposition = denied
		out.Reinstate = denied
		out.Archive = denied
		out.Unarchive = denied
	}
	state := x.meeting.OccurrenceState
	if state != "unconfirmed" && state != "scheduled" {
		out.Cancel = operationField("blocked", "meeting_already_started")
	}
	if state != "cancelled" {
		out.AppendDisposition = operationField("blocked", "meeting_not_cancelled")
		out.Reinstate = operationField("blocked", "meeting_not_cancelled")
	}
	if x.meeting.ArchivedAt.Valid {
		out.Archive = operationField("blocked", "meeting_archived")
		out.AddPreparation = operationField("blocked", "meeting_archived")
		out.ApplyTemplate = out.AddPreparation
	} else {
		out.Unarchive = operationField("blocked", "meeting_not_archived")
	}
	if state == "cancelled" {
		out.AddPreparation = operationField("blocked", "meeting_cancelled")
		out.ApplyTemplate = out.AddPreparation
	}
	out.CanAddPreparation = out.AddPreparation.State == "allowed"
	if x.work != nil {
		out.Delete = operationField("blocked", "meeting_workflow_history")
		out.Targets = append(out.Targets, IssueOperationTarget{Kind: "meeting", MeetingID: out.MeetingID, View: "workflow", Label: "Minutes workflow", Purpose: "meeting_workflow_history"})
		out.TargetsTotal++
	}
	retained, e := q.ReadCockpitMeetingRetainedTargets(ctx, db.ReadCockpitMeetingRetainedTargetsParams{WorkspaceID: p.WorkspaceID, SourceMeetingID: p.MeetingID})
	if e != nil {
		return out, e
	}
	for i, r := range retained {
		if i == 0 {
			out.TargetsTotal += r.Total
		}
		if r.ArtifactID.Valid {
			out.Delete = operationField("blocked", "retained_artifact_source")
			if len(out.Targets) < 3 {
				out.Targets = append(out.Targets, IssueOperationTarget{Kind: "artifact", ArtifactID: util.UUIDToString(r.ArtifactID), Label: r.Label, Purpose: r.Purpose})
			}
		}
		if r.DirectoryOperationID.Valid {
			out.Delete = operationField("blocked", "meeting_directory_history")
			if len(out.Targets) < 3 {
				out.Targets = append(out.Targets, IssueOperationTarget{Kind: "meeting", MeetingID: out.MeetingID, View: "resources", DirectoryOperationID: util.UUIDToString(r.DirectoryOperationID), Label: r.Label, Purpose: r.Purpose})
			}
		}
		if r.OperationID.Valid {
			out.Delete = operationField("blocked", "meeting_preparation_history")
			if len(out.Targets) < 3 {
				out.Targets = append(out.Targets, IssueOperationTarget{Kind: "meeting", MeetingID: out.MeetingID, View: "agenda", OperationID: util.UUIDToString(r.OperationID), Label: r.Label, Purpose: r.Purpose})
			}
		}
	}
	inputsRetained, e := q.HasCockpitInputMeetingReferences(ctx, db.HasCockpitInputMeetingReferencesParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID})
	if e != nil {
		return out, e
	}
	if inputsRetained {
		out.Delete = operationField("blocked", "meeting_input_references")
		out.TargetsTotal++
		if len(out.Targets) < 3 {
			meetings, err := q.ReadCockpitInputSourceMeetings(ctx, db.ReadCockpitInputSourceMeetingsParams{WorkspaceID: p.WorkspaceID, Ids: []pgtype.UUID{p.MeetingID}})
			if err != nil {
				return out, err
			}
			if len(meetings) != 1 {
				return out, ErrCockpitWorkflowNotFound
			}
			out.Targets = append(out.Targets, IssueOperationTarget{Kind: "meeting", MeetingID: out.MeetingID, View: "resources", Label: meetings[0].Title, Purpose: "meeting_input_references"})
		}
	}
	counts, e := q.ReadCockpitMeetingPendingCounts(ctx, db.ReadCockpitMeetingPendingCountsParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID})
	if e != nil {
		return out, e
	}
	if e = json.Unmarshal(counts, &out.Pending); e != nil {
		return out, e
	}
	current, e := q.GetCurrentCockpitPreparationOperation(ctx, db.GetCurrentCockpitPreparationOperationParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID})
	if e == nil {
		h, readErr := preparationHeader(ctx, q, p, current)
		if readErr != nil {
			return out, readErr
		}
		out.CurrentOperation = &h
	} else if !errors.Is(e, pgx.ErrNoRows) {
		return out, e
	}
	return out, nil
}
