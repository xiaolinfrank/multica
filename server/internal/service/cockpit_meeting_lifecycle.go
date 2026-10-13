package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

var ErrCockpitLifecycleGone = errors.New("the original meeting command target was removed; this key cannot recreate it")

type CockpitAgendaReferenceExistsError struct{ ReferenceID string }

func (e *CockpitAgendaReferenceExistsError) Unwrap() error { return ErrCockpitWorkflowConflict }
func (e *CockpitAgendaReferenceExistsError) Error() string {
	return "this agenda already references the selected object"
}

type lifecycleState struct {
	meeting db.GetCockpitMeetingLifecycleRow
	work    *cockpitMinutesState
}
type lifecycleCommand struct {
	CockpitLifecycleRead
	key               pgtype.UUID
	action, hash      string
	agenda, reference pgtype.UUID
	expected          int64
}

func lifecycleTime(t pgtype.Timestamptz) *string {
	if !t.Valid {
		return nil
	}
	s := t.Time.UTC().Format(time.RFC3339Nano)
	return &s
}
func lifecycleOccurrence(m db.GetCockpitMeetingLifecycleRow) CockpitOccurrenceView {
	return CockpitOccurrenceView{State: m.OccurrenceState, StartedConfirmedAt: lifecycleTime(m.StartedConfirmedAt), StartedConfirmedBy: planningUUID(m.StartedConfirmedBy), EndedAt: lifecycleTime(m.EndedAt), EndedBy: planningUUID(m.EndedBy), EndedSource: planningText(m.EndedSource), ActualStartedAt: lifecycleTime(m.ActualStartedAt), ActualEndedAt: lifecycleTime(m.ActualEndedAt), CancelledAt: lifecycleTime(m.CancelledAt), CancelledBy: planningUUID(m.CancelledBy), CancelledReason: m.CancelledReason}
}
func lifecycleMaterials(w *cockpitMinutesState) *CockpitMaterialsView {
	if w == nil {
		return nil
	}
	return &CockpitMaterialsView{WorkflowRevision: w.Revision, Ready: w.MaterialsReady, ConfirmedAt: lifecycleTime(w.MaterialsConfirmedAt), ConfirmedBy: planningUUID(w.MaterialsConfirmedBy), Released: w.Released}
}
func readLifecycleState(ctx context.Context, q *db.Queries, p CockpitLifecycleRead) (lifecycleState, error) {
	m, e := q.GetCockpitMeetingLifecycle(ctx, db.GetCockpitMeetingLifecycleParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID})
	if e != nil {
		return lifecycleState{}, cockpitWorkflowError(e)
	}
	x := lifecycleState{meeting: m}
	w, e := q.GetCockpitMeetingWorkPackage(ctx, db.GetCockpitMeetingWorkPackageParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID})
	if e != nil {
		return x, e
	}
	if w.MinutesIssueID.Valid {
		x.work = ptr(minutesStateFromGet(p.WorkspaceID, w))
	}
	return x, nil
}
func lifecycleManager(ctx context.Context, q *db.Queries, x lifecycleState, p CockpitLifecycleRead) bool {
	return p.Human && (x.work == nil || requireCockpitWorkflowManager(ctx, q, *x.work, p.ActorID) == nil)
}
func lifecycleHeader(ctx context.Context, q *db.Queries, x lifecycleState, p CockpitLifecycleRead) (CockpitMeetingLifecycleHeader, error) {
	total, e := q.CountCockpitAgenda(ctx, db.CountCockpitAgendaParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID})
	if e != nil {
		return CockpitMeetingLifecycleHeader{}, e
	}
	manager := lifecycleManager(ctx, q, x, p)
	state := x.meeting.OccurrenceState
	h := CockpitMeetingLifecycleHeader{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), LifecycleRevision: x.meeting.LifecycleRevision, AgendaRevision: x.meeting.AgendaRevision, GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano), Occurrence: lifecycleOccurrence(x.meeting), Materials: lifecycleMaterials(x.work), WorkflowEnabled: x.work != nil, AgendaTotal: total, CanSchedule: manager && state == "unconfirmed", CanEnd: manager && (state == "unconfirmed" || state == "scheduled"), CanCorrectTimes: manager && (state == "scheduled" || state == "ended"), CanEditAgenda: p.Human && state != "cancelled" && !x.meeting.ArchivedAt.Valid, Archive: lifecycleArchive(x.meeting), CanConfirmMaterials: manager && x.work != nil && state != "cancelled", CanReopen: manager && state == "ended", CanUnschedule: manager && state == "scheduled" && !x.meeting.EndedAt.Valid, BlockedReasons: []CockpitLifecycleBlock{}}
	if !p.Human {
		h.BlockedReasons = append(h.BlockedReasons, CockpitLifecycleBlock{Action: "write", Code: "human_required"})
	} else if !manager {
		h.BlockedReasons = append(h.BlockedReasons, CockpitLifecycleBlock{Action: "occurrence", Code: "workflow_manager_required"})
	}
	if x.work == nil {
		h.BlockedReasons = append(h.BlockedReasons, CockpitLifecycleBlock{Action: "materials", Code: "workflow_required"})
	} else if x.work.Released {
		h.BlockedReasons = append(h.BlockedReasons, CockpitLifecycleBlock{Action: "materials", Code: "readiness_fixed_after_release"})
	}
	return h, nil
}
func (s *IssueService) GetCockpitMeetingLifecycle(ctx context.Context, p CockpitLifecycleRead) (CockpitMeetingLifecycleHeader, error) {
	tx, q, e := s.beginPlanningRead(ctx)
	if e != nil {
		return CockpitMeetingLifecycleHeader{}, e
	}
	defer tx.Rollback(ctx)
	if e = cockpitWorkflowMember(ctx, q, p.WorkspaceID, p.ActorID); e != nil {
		return CockpitMeetingLifecycleHeader{}, e
	}
	x, e := readLifecycleState(ctx, q, p)
	if e != nil {
		return CockpitMeetingLifecycleHeader{}, e
	}
	return lifecycleHeader(ctx, q, x, p)
}
func newLifecycleCommand(p CockpitLifecycleRead, input CockpitLifecycleCommandInput, action string, agenda, ref pgtype.UUID, body any) (lifecycleCommand, error) {
	key, e := util.ParseUUID(input.CommandKey)
	if e != nil || !key.Valid || input.ExpectedRevision < 1 {
		return lifecycleCommand{}, fmt.Errorf("%w: command_key and positive expected_revision are required", ErrCockpitWorkflowInput)
	}
	if !p.Human {
		return lifecycleCommand{}, ErrCockpitWorkflowForbidden
	}
	return lifecycleCommand{CockpitLifecycleRead: p, key: key, action: action, agenda: agenda, reference: ref, expected: input.ExpectedRevision, hash: planningHash(struct {
		Action            string
		Agenda, Reference pgtype.UUID
		Body              any
	}{action, agenda, ref, body})}, nil
}
func lockLifecycleMember(ctx context.Context, q *db.Queries, c lifecycleCommand) error {
	if _, e := q.LockWorkspaceForChatSessionCreate(ctx, c.WorkspaceID); e != nil {
		return cockpitWorkflowError(e)
	}
	_, e := q.LockCockpitCreationMember(ctx, db.LockCockpitCreationMemberParams{WorkspaceID: c.WorkspaceID, UserID: c.ActorID})
	if errors.Is(e, pgx.ErrNoRows) {
		return ErrCockpitWorkflowForbidden
	}
	return e
}
func lifecycleReplay(ctx context.Context, q *db.Queries, c lifecycleCommand) (*CockpitLifecycleCommandResult, error) {
	old, e := q.GetCockpitLifecycleCommand(ctx, db.GetCockpitLifecycleCommandParams{WorkspaceID: c.WorkspaceID, MeetingID: c.MeetingID, CommandKey: c.key})
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	if old.ActorID != c.ActorID || old.Kind != c.action || old.RequestHash != c.hash {
		return nil, fmt.Errorf("%w: command key belongs to another intent", ErrCockpitWorkflowConflict)
	}
	x, e := readLifecycleState(ctx, q, c.CockpitLifecycleRead)
	if errors.Is(e, ErrCockpitWorkflowNotFound) {
		return nil, ErrCockpitLifecycleGone
	}
	if e != nil {
		return nil, e
	}
	// A remove receipt is the successful terminal result, not a missing create.
	if old.AgendaID.Valid && c.action != "agenda_remove" && c.action != "reference_remove" {
		a, e := q.GetCockpitMeetingAgenda(ctx, db.GetCockpitMeetingAgendaParams{WorkspaceID: c.WorkspaceID, MeetingID: c.MeetingID, ID: old.AgendaID})
		if errors.Is(e, pgx.ErrNoRows) || (e == nil && a.RemovedAt.Valid && c.action != "agenda_remove" && c.action != "reference_remove") {
			return nil, ErrCockpitLifecycleGone
		}
		if e != nil {
			return nil, e
		}
	}
	if old.ReferenceID.Valid && c.action != "reference_remove" {
		r, e := q.GetCockpitAgendaReference(ctx, db.GetCockpitAgendaReferenceParams{WorkspaceID: c.WorkspaceID, MeetingID: c.MeetingID, AgendaID: old.AgendaID, ID: old.ReferenceID})
		if errors.Is(e, pgx.ErrNoRows) || (e == nil && r.RemovedAt.Valid) {
			return nil, ErrCockpitLifecycleGone
		}
		if e != nil {
			return nil, e
		}
		if e = validateAgendaReferenceTarget(ctx, q, c.CockpitLifecycleRead, r.Kind, r.TargetID); e != nil {
			if errors.Is(e, ErrCockpitWorkflowNotFound) || errors.Is(e, ErrCockpitWorkflowConflict) {
				return nil, ErrCockpitLifecycleGone
			}
			return nil, e
		}
	}
	if old.IssueID.Valid {
		if _, e = q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: c.WorkspaceID, ID: old.IssueID}); errors.Is(e, pgx.ErrNoRows) {
			return nil, ErrCockpitLifecycleGone
		} else if e != nil {
			return nil, e
		}
	}
	var receipt CockpitLifecycleReceipt
	if e = json.Unmarshal(old.Receipt, &receipt); e != nil {
		return nil, e
	}
	h, e := lifecycleHeader(ctx, q, x, c.CockpitLifecycleRead)
	if e != nil {
		return nil, e
	}
	return &CockpitLifecycleCommandResult{WorkspaceID: util.UUIDToString(c.WorkspaceID), MeetingID: util.UUIDToString(c.MeetingID), CommandKey: util.UUIDToString(c.key), Action: c.action, Replayed: true, Receipt: receipt, Current: h}, nil
}
func lockLifecycleMeeting(ctx context.Context, q *db.Queries, ws, meeting pgtype.UUID) (db.CockpitMeeting, error) {
	board, e := q.LockCockpitForWorkspaceChanges(ctx, ws)
	if e != nil {
		return db.CockpitMeeting{}, cockpitWorkflowError(e)
	}
	m, e := q.LockCockpitMeetingForWork(ctx, db.LockCockpitMeetingForWorkParams{WorkspaceID: ws, ID: meeting})
	if e != nil {
		return m, cockpitWorkflowError(e)
	}
	if m.CockpitID != board {
		return m, ErrCockpitWorkflowNotFound
	}
	return m, nil
}
func (s *IssueService) beginLifecycleWrite(ctx context.Context, c lifecycleCommand) (pgx.Tx, *db.Queries, lifecycleState, *CockpitLifecycleCommandResult, error) {
	tx, e := s.TxStarter.Begin(ctx)
	if e != nil {
		return nil, nil, lifecycleState{}, nil, e
	}
	q := s.Queries.WithTx(tx)
	fail := func(e error) (pgx.Tx, *db.Queries, lifecycleState, *CockpitLifecycleCommandResult, error) {
		_ = tx.Rollback(ctx)
		return nil, nil, lifecycleState{}, nil, e
	}
	if e = lockLifecycleMember(ctx, q, c); e != nil {
		return fail(e)
	}
	if old, e := lifecycleReplay(ctx, q, c); old != nil || e != nil {
		if e != nil {
			return fail(e)
		}
		return tx, q, lifecycleState{}, old, nil
	}
	if _, e = lockLifecycleMeeting(ctx, q, c.WorkspaceID, c.MeetingID); e != nil {
		return fail(e)
	}
	if old, e := lifecycleReplay(ctx, q, c); old != nil || e != nil {
		if e != nil {
			return fail(e)
		}
		return tx, q, lifecycleState{}, old, nil
	}
	x, e := readLifecycleState(ctx, q, c.CockpitLifecycleRead)
	if e != nil {
		return fail(e)
	}
	if x.work != nil {
		w, e := q.LockCockpitMeetingWorkPackage(ctx, db.LockCockpitMeetingWorkPackageParams{WorkspaceID: c.WorkspaceID, ID: c.MeetingID})
		if e != nil {
			return fail(e)
		}
		x.work = ptr(minutesStateFromLock(c.WorkspaceID, w))
	}
	return tx, q, x, nil, nil
}
func storeLifecycleReceipt(ctx context.Context, q *db.Queries, c lifecycleCommand, r CockpitLifecycleReceipt) error {
	r.RequestHash = c.hash
	body, e := json.Marshal(r)
	if e != nil {
		return e
	}
	id := func(v *string) pgtype.UUID {
		if v == nil {
			return pgtype.UUID{}
		}
		u, _ := util.ParseUUID(*v)
		return u
	}
	var operation, effect pgtype.UUID
	if r.Preparation != nil {
		operation, _ = util.ParseUUID(r.Preparation.OperationID)
		effect = id(r.Preparation.EffectID)
	}
	return q.CreateCockpitLifecycleCommand(ctx, db.CreateCockpitLifecycleCommandParams{WorkspaceID: c.WorkspaceID, MeetingID: c.MeetingID, CommandKey: c.key, Kind: c.action, ActorID: c.ActorID, RequestHash: c.hash, Revision: r.Revision, AgendaRevision: r.AgendaRevision, AgendaID: id(r.AgendaID), ReferenceID: id(r.ReferenceID), IssueID: id(r.IssueID), OperationID: operation, EffectID: effect, Receipt: body})
}
func (s *IssueService) finishLifecycleWrite(ctx context.Context, tx pgx.Tx, q *db.Queries, c lifecycleCommand, r CockpitLifecycleReceipt) (CockpitLifecycleCommandResult, error) {
	r.RequestHash = c.hash
	if e := storeLifecycleReceipt(ctx, q, c, r); e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	x, e := readLifecycleState(ctx, q, c.CockpitLifecycleRead)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	h, e := lifecycleHeader(ctx, q, x, c.CockpitLifecycleRead)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	if e = tx.Commit(ctx); e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	s.lifecycleChanged(c)
	return CockpitLifecycleCommandResult{WorkspaceID: util.UUIDToString(c.WorkspaceID), MeetingID: util.UUIDToString(c.MeetingID), CommandKey: util.UUIDToString(c.key), Action: c.action, Receipt: r, Current: h}, nil
}
func (s *IssueService) lifecycleChanged(c lifecycleCommand) {
	fields := map[string]any{"meeting_id": util.UUIDToString(c.MeetingID)}
	if c.agenda.Valid {
		fields["agenda_id"] = util.UUIDToString(c.agenda)
	}
	s.planningChanged(c.WorkspaceID, c.ActorID, "meeting_lifecycle", fields)
	s.planningChanged(c.WorkspaceID, c.ActorID, "meeting_workflow", fields)
}
func optionalLifecycleTime(raw json.RawMessage, old pgtype.Timestamptz) (pgtype.Timestamptz, error) {
	if len(raw) == 0 {
		return old, nil
	}
	if string(raw) == "null" {
		return pgtype.Timestamptz{}, nil
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return old, fmt.Errorf("%w: actual time must be RFC3339 or null", ErrCockpitWorkflowInput)
	}
	t, e := time.Parse(time.RFC3339Nano, value)
	if e != nil {
		return old, fmt.Errorf("%w: actual time must include its timezone", ErrCockpitWorkflowInput)
	}
	return pgtype.Timestamptz{Time: t.UTC(), Valid: true}, nil
}

// applyMeetingOccurrence is the single ended-fact writer, including legacy readiness.
// "reopen" is the explicit reverse of "end": it restores scheduled and clears the
// ended facts (including actual_ended_at, keeping actual_started_at) while both
// receipts stay in the command ledger (meeting-lifecycle-contract R2).
// "unschedule" withdraws the schedule confirmation of a scanned, human-checked
// meeting. The R4 collapse removed the start confirmation entirely: "in
// progress" is a projection of the scheduled time window, so actual start
// times are recorded through correct_times like every other measured time.
func applyMeetingOccurrence(ctx context.Context, q *db.Queries, p CockpitLifecycleRead, m db.GetCockpitMeetingLifecycleRow, in CockpitOccurrenceInput) (db.GetCockpitMeetingLifecycleRow, error) {
	if m.OccurrenceState == "cancelled" {
		return m, fmt.Errorf("%w: explicitly reschedule this cancelled meeting first", ErrCockpitWorkflowConflict)
	}
	if in.ExpectedRevision != m.LifecycleRevision {
		return m, ErrCockpitWorkflowConflict
	}
	var e error
	m.ActualStartedAt, e = optionalLifecycleTime(in.ActualStartedAt, m.ActualStartedAt)
	if e != nil {
		return m, e
	}
	m.ActualEndedAt, e = optionalLifecycleTime(in.ActualEndedAt, m.ActualEndedAt)
	if e != nil {
		return m, e
	}
	now := m.DatabaseNow.Time
	switch in.Transition {
	case "schedule":
		if m.OccurrenceState != "unconfirmed" || len(in.ActualStartedAt) > 0 || len(in.ActualEndedAt) > 0 {
			return m, ErrCockpitWorkflowConflict
		}
		m.OccurrenceState = "scheduled"
	case "end":
		if m.EndedAt.Valid {
			return m, ErrCockpitWorkflowConflict
		}
		m.OccurrenceState = "ended"
		m.EndedAt = pgtype.Timestamptz{Time: now, Valid: true}
		m.EndedBy = p.ActorID
		m.EndedSource = pgtype.Text{String: "human_confirmation", Valid: true}
	case "correct_times":
		if (m.OccurrenceState != "scheduled" && m.OccurrenceState != "ended") || strings.TrimSpace(in.Reason) == "" || len(in.Reason) > 16000 || len(in.ActualStartedAt)+len(in.ActualEndedAt) == 0 {
			return m, fmt.Errorf("%w: explicit times and a reason are required", ErrCockpitWorkflowInput)
		}
	case "reopen":
		// R2 reversibility: the reverse of end. Withdraw a mistaken end
		// confirmation, return the occurrence to scheduled so cancellation or
		// rescheduling stays reachable, and leave the original end receipt in
		// the command ledger. actual_ended_at is cleared together with the end
		// facts so the "actual end requires a confirmed end" rule keeps
		// holding; the actual start time survives as a recorded fact.
		if m.OccurrenceState != "ended" {
			return m, ErrCockpitWorkflowConflict
		}
		if strings.TrimSpace(in.Reason) == "" || len(in.Reason) > 16000 {
			return m, fmt.Errorf("%w: a reason is required to reopen an ended meeting", ErrCockpitWorkflowInput)
		}
		m.OccurrenceState = "scheduled"
		m.EndedAt = pgtype.Timestamptz{}
		m.EndedBy = pgtype.UUID{}
		m.EndedSource = pgtype.Text{}
		m.ActualEndedAt = pgtype.Timestamptz{}
	case "unschedule":
		// R3 reversibility: the reverse of schedule. Only the schedule
		// confirmation is withdrawn; recorded facts (actual times kept by
		// reopen) survive untouched. Requires the started facts to be absent,
		// so a meeting that already began must unstart first.
		if m.OccurrenceState != "scheduled" || m.StartedConfirmedAt.Valid || m.EndedAt.Valid {
			return m, ErrCockpitWorkflowConflict
		}
		if strings.TrimSpace(in.Reason) == "" || len(in.Reason) > 16000 {
			return m, fmt.Errorf("%w: a reason is required to withdraw the schedule confirmation", ErrCockpitWorkflowInput)
		}
		m.OccurrenceState = "unconfirmed"
	default:
		return m, ErrCockpitWorkflowInput
	}
	if (m.ActualStartedAt.Valid && m.ActualStartedAt.Time.After(now)) || (m.ActualEndedAt.Valid && (!m.EndedAt.Valid || m.ActualEndedAt.Time.After(now))) || (m.ActualStartedAt.Valid && m.ActualEndedAt.Valid && m.ActualStartedAt.Time.After(m.ActualEndedAt.Time)) {
		return m, fmt.Errorf("%w: actual meeting times are inconsistent or in the future", ErrCockpitWorkflowInput)
	}
	revision, e := q.SetCockpitMeetingOccurrence(ctx, db.SetCockpitMeetingOccurrenceParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ActorID: p.ActorID, ExpectedRevision: m.LifecycleRevision, State: m.OccurrenceState, StartedAt: m.StartedConfirmedAt, StartedBy: m.StartedConfirmedBy, EndedAt: m.EndedAt, EndedBy: m.EndedBy, EndedSource: m.EndedSource, ActualStartedAt: m.ActualStartedAt, ActualEndedAt: m.ActualEndedAt})
	m.LifecycleRevision = revision
	if e != nil {
		return m, cockpitWorkflowError(e)
	}
	// Read the database's timestamp precision before persisting the exact receipt.
	return q.GetCockpitMeetingLifecycle(ctx, db.GetCockpitMeetingLifecycleParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID})
}
func (s *IssueService) ChangeCockpitMeetingOccurrence(ctx context.Context, p CockpitLifecycleRead, in CockpitOccurrenceInput) (CockpitLifecycleCommandResult, error) {
	in.Reason = strings.TrimSpace(in.Reason)
	if len(in.Reason) > 16000 {
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
	m, e := applyMeetingOccurrence(ctx, q, p, x.meeting, in)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	if e = q.BumpCockpitWorkflowRevisionForOccurrence(ctx, db.BumpCockpitWorkflowRevisionForOccurrenceParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID}); e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	o := lifecycleOccurrence(m)
	previous := lifecycleOccurrence(x.meeting)
	return s.finishLifecycleWrite(ctx, tx, q, c, CockpitLifecycleReceipt{Revision: m.LifecycleRevision, AgendaRevision: m.AgendaRevision, Occurrence: &o, PreviousOccurrence: &previous, Reason: strings.TrimSpace(in.Reason)})
}
func (s *IssueService) ConfirmCockpitMeetingMaterials(ctx context.Context, p CockpitLifecycleRead, in CockpitMaterialsInput) (CockpitLifecycleCommandResult, error) {
	c, e := newLifecycleCommand(p, in.CockpitLifecycleCommandInput, "materials", pgtype.UUID{}, pgtype.UUID{}, in)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	if in.MaterialsReady == nil {
		return CockpitLifecycleCommandResult{}, ErrCockpitWorkflowInput
	}
	tx, q, x, old, e := s.beginLifecycleWrite(ctx, c)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	defer tx.Rollback(ctx)
	if old != nil {
		return *old, nil
	}
	if x.meeting.OccurrenceState == "cancelled" {
		return CockpitLifecycleCommandResult{}, fmt.Errorf("%w: reschedule this cancelled meeting before confirming materials", ErrCockpitWorkflowConflict)
	}
	if x.work == nil {
		return CockpitLifecycleCommandResult{}, fmt.Errorf("%w: enable a minutes work package before confirming materials", ErrCockpitWorkflowConflict)
	}
	if !lifecycleManager(ctx, q, x, p) {
		return CockpitLifecycleCommandResult{}, ErrCockpitWorkflowForbidden
	}
	if x.work.Released || x.work.Revision != in.ExpectedRevision {
		return CockpitLifecycleCommandResult{}, ErrCockpitWorkflowConflict
	}
	w, e := q.SetCockpitMeetingReadiness(ctx, db.SetCockpitMeetingReadinessParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID, ActorID: p.ActorID, MaterialsReady: pgtype.Bool{Bool: *in.MaterialsReady, Valid: true}, ExpectedRevision: in.ExpectedRevision})
	if e != nil {
		return CockpitLifecycleCommandResult{}, cockpitWorkflowError(e)
	}
	state := minutesStateFromReadiness(p.WorkspaceID, w)
	return s.finishLifecycleWrite(ctx, tx, q, c, CockpitLifecycleReceipt{Revision: w.Revision, AgendaRevision: x.meeting.AgendaRevision, Materials: lifecycleMaterials(&state)})
}
