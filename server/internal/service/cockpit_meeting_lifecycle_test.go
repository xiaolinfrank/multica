package service

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func lifecycleFixture(t *testing.T) cockpitWorkflowFixture {
	t.Helper()
	f := newCockpitWorkflowFixture(t)
	f.Cleanup(t, "DELETE FROM cockpit_meeting_lifecycle_command WHERE workspace_id=$1", f.ws)
	return f
}
func lifecycleRead(f cockpitWorkflowFixture) CockpitLifecycleRead {
	return CockpitLifecycleRead{WorkspaceID: f.ws, MeetingID: f.meeting, ActorID: f.owner, Human: true}
}
func lifecycleInput(revision int64) CockpitLifecycleCommandInput {
	return CockpitLifecycleCommandInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: revision}
}
func TestCockpitLifecycleRecordsFactsWithoutWorkPackageOrExecution(t *testing.T) {
	f := lifecycleFixture(t)
	ctx := context.Background()
	p := lifecycleRead(f)
	if _, e := f.Pool.Exec(ctx, "UPDATE cockpit_meeting SET status='已结束',meet_date='2020-01-01' WHERE workspace_id=$1 AND id=$2", f.ws, f.meeting); e != nil {
		t.Fatal(e)
	}
	h, e := f.issues.GetCockpitMeetingLifecycle(ctx, p)
	if e != nil {
		t.Fatal(e)
	}
	if h.Occurrence.State != "scheduled" || h.WorkflowEnabled || h.Materials != nil || h.AgendaRevision != 1 || h.AgendaTotal != 0 || h.CanEditAgenda {
		t.Fatalf("legacy free text became fact: %+v", h)
	}
	in := CockpitOccurrenceInput{CockpitLifecycleCommandInput: lifecycleInput(h.LifecycleRevision), Transition: "end"}
	result, e := f.issues.ChangeCockpitMeetingOccurrence(ctx, p, in)
	if e != nil {
		t.Fatal(e)
	}
	if result.Current.Occurrence.State != "ended" || result.Receipt.Occurrence.EndedAt == nil || result.Receipt.Occurrence.ActualEndedAt != nil || result.Current.WorkflowEnabled {
		t.Fatalf("confirmation invented actual time or workflow: %+v", result)
	}
	replay, e := f.issues.ChangeCockpitMeetingOccurrence(ctx, p, in)
	if e != nil || !replay.Replayed || *replay.Receipt.Occurrence.EndedAt != *result.Receipt.Occurrence.EndedAt {
		t.Fatalf("end replay: %+v %v", replay, e)
	}
	actual := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
	body, _ := json.Marshal(actual)
	correction := CockpitOccurrenceInput{CockpitLifecycleCommandInput: lifecycleInput(result.Current.LifecycleRevision), Transition: "correct_times", ActualEndedAt: body, Reason: "The offline meeting ended before this record was entered."}
	corrected, e := f.issues.ChangeCockpitMeetingOccurrence(ctx, p, correction)
	if e != nil {
		t.Fatal(e)
	}
	if corrected.Receipt.PreviousOccurrence.ActualEndedAt != nil || corrected.Receipt.Occurrence.ActualEndedAt == nil || *corrected.Receipt.Occurrence.EndedAt != *result.Receipt.Occurrence.EndedAt {
		t.Fatal("correction changed confirmation or lost previous facts")
	}
	key, _ := util.ParseUUID(correction.CommandKey)
	detail, e := f.issues.GetCockpitMeetingLifecycleCommand(ctx, p, key)
	if e != nil || detail.Receipt.Reason != correction.Reason {
		t.Fatalf("audit detail: %+v %v", detail, e)
	}
	reopened, e := f.issues.ChangeCockpitMeetingOccurrence(ctx, p, CockpitOccurrenceInput{CockpitLifecycleCommandInput: lifecycleInput(corrected.Current.LifecycleRevision), Transition: "reopen", Reason: "Withdraw the mistaken end confirmation."})
	if e != nil || reopened.Current.Occurrence.State != "scheduled" || reopened.Current.Occurrence.EndedAt != nil || reopened.Current.Occurrence.ActualEndedAt != nil || reopened.Receipt.PreviousOccurrence == nil || reopened.Receipt.PreviousOccurrence.EndedAt == nil {
		t.Fatalf("explicit reopen did not reverse the confirmation: %+v %v", reopened, e)
	}
	retained, e := f.issues.GetCockpitMeetingLifecycleCommand(ctx, p, key)
	if e != nil || retained.Receipt.Occurrence.ActualEndedAt == nil || *retained.Receipt.Occurrence.EndedAt != *result.Receipt.Occurrence.EndedAt {
		t.Fatalf("reopen lost the original correction receipt: %+v %v", retained, e)
	}
	var issues, runs int
	if e = f.Pool.QueryRow(ctx, "SELECT (SELECT count(*) FROM issue WHERE workspace_id=$1),(SELECT count(*) FROM agent_task_queue q JOIN issue i ON i.id=q.issue_id WHERE i.workspace_id=$1)", f.ws).Scan(&issues, &runs); e != nil {
		t.Fatal(e)
	}
	if issues != 0 || runs != 0 {
		t.Fatalf("occurrence side effects: issues=%d runs=%d", issues, runs)
	}
	p.Human = false
	if _, e = f.issues.ChangeCockpitMeetingOccurrence(ctx, p, correction); !errors.Is(e, ErrCockpitWorkflowForbidden) {
		t.Fatalf("machine confirmation: %v", e)
	}
}
func TestCockpitLifecycleLegacyReadinessSharesEndAuthority(t *testing.T) {
	f := lifecycleFixture(t)
	ctx := context.Background()
	p := lifecycleRead(f)
	f.init(t, "")
	out, e := f.issues.ChangeCockpitMeetingOccurrence(ctx, p, CockpitOccurrenceInput{CockpitLifecycleCommandInput: lifecycleInput(1), Transition: "end"})
	if e != nil {
		t.Fatal(e)
	}
	if f.work(t).Revision != 3 {
		t.Fatal("occurrence did not invalidate the legacy workflow revision")
	}
	f.ready(t)
	h, e := f.issues.GetCockpitMeetingLifecycle(ctx, p)
	if e != nil {
		t.Fatal(e)
	}
	if *h.Occurrence.EndedAt != *out.Receipt.Occurrence.EndedAt || !h.Materials.Ready {
		t.Fatal("legacy readiness diverged from meeting end")
	}
	if e = f.issues.ReleaseCockpitMeetingMinutes(ctx, f.command(t)); e != nil {
		t.Fatal(e)
	}
	if _, e = f.issues.ConfirmCockpitMeetingMaterials(ctx, p, CockpitMaterialsInput{CockpitLifecycleCommandInput: lifecycleInput(f.work(t).Revision), MaterialsReady: boolPointer(false)}); !errors.Is(e, ErrCockpitWorkflowConflict) {
		t.Fatalf("released materials mutated: %v", e)
	}
	var oldColumn bool
	if e = f.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='cockpit_meeting_work_package' AND column_name='ended_at')").Scan(&oldColumn); e != nil || oldColumn {
		t.Fatalf("second end authority remains: %v %v", oldColumn, e)
	}
}
func boolPointer(v bool) *bool { return &v }

func TestCockpitLifecycleReplayPrecedesDemotionButRequiresMembership(t *testing.T) {
	f := lifecycleFixture(t)
	ctx := context.Background()
	f.init(t, "")
	user := f.User(t, "Temporary meeting manager", "meeting-manager-"+util.UUIDToString(dbid.NewV7())+"@multica.test")
	f.Member(t, f.WorkspaceID, user, "admin")
	actor := parseTestUUID(t, user)
	p := lifecycleRead(f)
	p.ActorID = actor
	in := CockpitOccurrenceInput{CockpitLifecycleCommandInput: lifecycleInput(1), Transition: "end"}
	first, e := f.issues.ChangeCockpitMeetingOccurrence(ctx, p, in)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.Pool.Exec(ctx, "UPDATE member SET role='member' WHERE workspace_id=$1 AND user_id=$2", f.ws, actor); e != nil {
		t.Fatal(e)
	}
	replay, e := f.issues.ChangeCockpitMeetingOccurrence(ctx, p, in)
	if e != nil || !replay.Replayed || replay.Receipt.Revision != first.Receipt.Revision || replay.Current.CanCorrectTimes {
		t.Fatalf("demotion hid exact receipt or retained manager power: %+v %v", replay, e)
	}
	changed := in
	changed.CommandKey = util.UUIDToString(dbid.NewV7())
	changed.ExpectedRevision = first.Current.LifecycleRevision
	changed.Transition = "correct_times"
	changed.Reason = "change"
	changed.ActualEndedAt = json.RawMessage(`null`)
	if _, e = f.issues.ChangeCockpitMeetingOccurrence(ctx, p, changed); !errors.Is(e, ErrCockpitWorkflowForbidden) {
		t.Fatalf("demoted actor could issue new command: %v", e)
	}
	if _, e = f.Pool.Exec(ctx, "DELETE FROM member WHERE workspace_id=$1 AND user_id=$2", f.ws, actor); e != nil {
		t.Fatal(e)
	}
	if _, e = f.issues.ChangeCockpitMeetingOccurrence(ctx, p, in); !errors.Is(e, ErrCockpitWorkflowForbidden) {
		t.Fatalf("removed member replayed private receipt: %v", e)
	}
}
func TestCockpitLifecycleNewAndLegacyEndSerialize(t *testing.T) {
	f := lifecycleFixture(t)
	ctx := context.Background()
	f.init(t, "")
	p := lifecycleRead(f)
	yes := true
	commands := []func() error{func() error {
		_, e := f.issues.ChangeCockpitMeetingOccurrence(ctx, p, CockpitOccurrenceInput{CockpitLifecycleCommandInput: lifecycleInput(1), Transition: "end"})
		return e
	}, func() error {
		return f.issues.SetCockpitMeetingReadiness(ctx, CockpitWorkPackageReadiness{CockpitWorkPackageCommand: CockpitWorkPackageCommand{WorkspaceID: f.ws, MeetingID: f.meeting, ActorID: f.owner, ExpectedRevision: 1}, Ended: &yes, MaterialsReady: &yes})
	}}
	start := make(chan struct{})
	done := make(chan error, 2)
	for _, run := range commands {
		go func(run func() error) { <-start; done <- run() }(run)
	}
	close(start)
	success := 0
	for range commands {
		e := <-done
		if e == nil {
			success++
		} else if !errors.Is(e, ErrCockpitWorkflowConflict) {
			t.Fatal(e)
		}
	}
	if success != 1 {
		t.Fatalf("racing revisions accepted %d writers", success)
	}
	h, e := f.issues.GetCockpitMeetingLifecycle(ctx, p)
	if e != nil {
		t.Fatal(e)
	}
	if h.LifecycleRevision != 2 || h.Materials.WorkflowRevision != 3 || h.Occurrence.EndedAt == nil || h.Occurrence.ActualEndedAt != nil {
		t.Fatalf("racing end split authority: %+v", h)
	}
}

func TestCockpitLifecycleCommandHistoryNewestFirstWithTimestampTies(t *testing.T) {
	f := lifecycleFixture(t)
	ctx := context.Background()
	p := lifecycleRead(f)
	f.init(t, "")
	keys := make([]string, 0, 31)
	ready := false
	for i := 0; i < 31; i++ {
		h, e := f.issues.GetCockpitMeetingLifecycle(ctx, p)
		if e != nil {
			t.Fatal(e)
		}
		value := ready
		in := CockpitMaterialsInput{CockpitLifecycleCommandInput: lifecycleInput(h.Materials.WorkflowRevision), MaterialsReady: &value}
		ready = !ready
		out, e := f.issues.ConfirmCockpitMeetingMaterials(ctx, p, in)
		if e != nil {
			t.Fatal(e)
		}
		keys = append(keys, out.CommandKey)
	}
	// Coarse timestamp precision must still give a deterministic UUID tie-break.
	if _, e := f.Pool.Exec(ctx, "UPDATE cockpit_meeting_lifecycle_command SET created_at='2020-01-01T00:00:00Z' WHERE workspace_id=$1 AND meeting_id=$2 AND kind='materials'", f.ws, f.meeting); e != nil {
		t.Fatal(e)
	}
	ended := CockpitOccurrenceInput{CockpitLifecycleCommandInput: lifecycleInput(1), Transition: "end"}
	first, e := f.issues.ChangeCockpitMeetingOccurrence(ctx, p, ended)
	if e != nil {
		t.Fatal(e)
	}
	actual, _ := json.Marshal(time.Now().UTC().Add(-3 * time.Hour).Format(time.RFC3339Nano))
	corrected := CockpitOccurrenceInput{CockpitLifecycleCommandInput: lifecycleInput(first.Current.LifecycleRevision), Transition: "correct_times", ActualEndedAt: actual, Reason: "Record the actual end after checking the offline notes."}
	if _, e = f.issues.ChangeCockpitMeetingOccurrence(ctx, p, corrected); e != nil {
		t.Fatal(e)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(keys)))
	expected := append([]string{corrected.CommandKey, ended.CommandKey}, keys...)
	query := CockpitLifecycleList{CockpitLifecycleRead: p, PageSize: 25}
	page, e := f.issues.ListCockpitMeetingLifecycleCommands(ctx, query)
	if e != nil {
		t.Fatal(e)
	}
	if page.Total != 33 || len(page.Items) != 25 || page.NextCursor == nil {
		t.Fatalf("history first page shape: total=%d items=%d next=%v", page.Total, len(page.Items), page.NextCursor)
	}
	if page.Items[0].CommandKey != corrected.CommandKey || page.Items[0].Action != "correct_times" {
		t.Fatalf("newest confirmed correction is buried behind old commands: first=%s/%s want=%s/correct_times", page.Items[0].CommandKey, page.Items[0].Action, corrected.CommandKey)
	}
	got := make([]string, 0, 33)
	for _, r := range page.Items {
		got = append(got, r.CommandKey)
	}
	legacyQuery := query
	last := page.Items[len(page.Items)-1]
	legacyQuery.Cursor = *encodeLifecycleCursor(lifecycleCursor{Scope: lifecycleCursorScope(query, "commands"), ID: last.CommandKey, Time: last.CreatedAt})
	if _, e = f.issues.ListCockpitMeetingLifecycleCommands(ctx, legacyQuery); !errors.Is(e, ErrCockpitWorkflowInput) {
		t.Fatalf("old ascending cursor was silently reused: %v", e)
	}
	query.Cursor = *page.NextCursor
	page, e = f.issues.ListCockpitMeetingLifecycleCommands(ctx, query)
	if e != nil {
		t.Fatal(e)
	}
	if page.Total != 33 || len(page.Items) != 8 || page.NextCursor != nil {
		t.Fatalf("history continuation: total=%d items=%d next=%v", page.Total, len(page.Items), page.NextCursor)
	}
	for _, r := range page.Items {
		got = append(got, r.CommandKey)
	}
	seen := map[string]bool{}
	for i, key := range got {
		if seen[key] || key != expected[i] {
			t.Fatalf("history tie order or pagination at %d: got=%s want=%s duplicate=%v", i, key, expected[i], seen[key])
		}
		seen[key] = true
	}
}
func TestCockpitLifecycleReopen(t *testing.T) {
	f := preparationFixture(t)
	ctx := context.Background()
	p := lifecycleRead(f)
	// A reopen before any end is a state conflict, not an input error.
	h, e := f.issues.GetCockpitMeetingLifecycle(ctx, p)
	if e != nil {
		t.Fatal(e)
	}
	reopen := CockpitOccurrenceInput{CockpitLifecycleCommandInput: lifecycleInput(h.LifecycleRevision), Transition: "reopen", Reason: "The end was recorded by mistake."}
	if _, e = f.issues.ChangeCockpitMeetingOccurrence(ctx, p, reopen); !errors.Is(e, ErrCockpitWorkflowConflict) {
		t.Fatalf("unconfirmed reopen: %v", e)
	}
	endInput := CockpitOccurrenceInput{CockpitLifecycleCommandInput: lifecycleInput(h.LifecycleRevision), Transition: "end"}
	ended, e := f.issues.ChangeCockpitMeetingOccurrence(ctx, p, endInput)
	if e != nil {
		t.Fatal(e)
	}
	started, _ := json.Marshal(time.Now().UTC().Add(-2 * time.Hour).Format(time.RFC3339Nano))
	finished, _ := json.Marshal(time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano))
	corrected, e := f.issues.ChangeCockpitMeetingOccurrence(ctx, p, CockpitOccurrenceInput{CockpitLifecycleCommandInput: lifecycleInput(ended.Current.LifecycleRevision), Transition: "correct_times", ActualStartedAt: started, ActualEndedAt: finished, Reason: "Record both actual times from the offline notes."})
	if e != nil {
		t.Fatal(e)
	}
	// While ended, cancellation stays gated behind an explicit reopen.
	blocked, e := f.issues.PreviewCockpitMeetingCancellation(ctx, p, CockpitCancellationPreviewInput{Reason: "Cancel after correcting the end."})
	if e != nil || blocked.CanConfirm {
		t.Fatalf("ended meeting cancelled without reopen: %+v %v", blocked, e)
	}
	// A reason is mandatory; the surrounding trim happens before validation.
	reopen.CockpitLifecycleCommandInput = lifecycleInput(corrected.Current.LifecycleRevision)
	reopen.Reason = "   "
	if _, e = f.issues.ChangeCockpitMeetingOccurrence(ctx, p, reopen); !errors.Is(e, ErrCockpitWorkflowInput) {
		t.Fatalf("reason-less reopen: %v", e)
	}
	reopen.Reason = "The end was recorded by mistake."
	reopened, e := f.issues.ChangeCockpitMeetingOccurrence(ctx, p, reopen)
	if e != nil {
		t.Fatal(e)
	}
	o, previous := reopened.Receipt.Occurrence, reopened.Receipt.PreviousOccurrence
	if reopened.Current.Occurrence.State != "scheduled" || o == nil || previous == nil {
		t.Fatalf("reopen lost its occurrence facts: %+v", reopened)
	}
	if o.State != "scheduled" || o.EndedAt != nil || o.EndedBy != nil || o.EndedSource != nil || o.ActualEndedAt != nil {
		t.Fatalf("reopen kept an ended fact: %+v", o)
	}
	if o.ActualStartedAt == nil || previous.State != "ended" || previous.EndedAt == nil || previous.ActualStartedAt == nil || previous.ActualEndedAt == nil {
		t.Fatalf("reopen dropped the recorded history: %+v", previous)
	}
	if !reopened.Current.CanCorrectTimes || !reopened.Current.CanEnd || reopened.Current.CanReopen {
		t.Fatalf("reopen left stale capabilities: %+v", reopened.Current)
	}
	// Both the original confirmation and the reopen stay in the command ledger.
	key, _ := util.ParseUUID(reopen.CommandKey)
	detail, e := f.issues.GetCockpitMeetingLifecycleCommand(ctx, p, key)
	if e != nil || detail.Action != "reopen" || detail.Receipt.Reason != reopen.Reason || detail.Receipt.Occurrence.EndedAt != nil || detail.Receipt.PreviousOccurrence.EndedAt == nil {
		t.Fatalf("reopen ledger detail: %+v %v", detail, e)
	}
	endKey, _ := util.ParseUUID(endInput.CommandKey)
	endDetail, e := f.issues.GetCockpitMeetingLifecycleCommand(ctx, p, endKey)
	if e != nil || endDetail.Action != "end" || endDetail.Receipt.Occurrence.EndedAt == nil {
		t.Fatalf("original confirmation left the ledger: %+v %v", endDetail, e)
	}
	replay, e := f.issues.ChangeCockpitMeetingOccurrence(ctx, p, reopen)
	if e != nil || !replay.Replayed || replay.Receipt.Revision != reopened.Receipt.Revision || replay.Current.Occurrence.State != "scheduled" {
		t.Fatalf("reopen replay: %+v %v", replay, e)
	}
	// A second reopen from scheduled is refused; the reopened meeting can still be cancelled.
	again := reopen
	again.CockpitLifecycleCommandInput = lifecycleInput(reopened.Current.LifecycleRevision)
	if _, e = f.issues.ChangeCockpitMeetingOccurrence(ctx, p, again); !errors.Is(e, ErrCockpitWorkflowConflict) {
		t.Fatalf("scheduled reopen: %v", e)
	}
	input := CockpitCancellationPreviewInput{Reason: "Cancel after correcting the mistaken end."}
	plan, e := f.issues.PreviewCockpitMeetingCancellation(ctx, p, input)
	if e != nil || !plan.CanConfirm || plan.Intent != "cancel" {
		t.Fatalf("reopened meeting cannot be cancelled: %+v %v", plan, e)
	}
	if _, e = f.issues.CancelCockpitMeeting(ctx, p, CockpitCancellationInput{CockpitLifecycleCommandInput: lifecycleInput(plan.LifecycleRevision), CockpitCancellationPreviewInput: input, ContextToken: plan.ContextToken}); e != nil {
		t.Fatal(e)
	}
	final, e := f.issues.GetCockpitMeetingLifecycle(ctx, p)
	if e != nil || final.Occurrence.State != "cancelled" || final.Occurrence.EndedAt != nil || final.CanCorrectTimes {
		t.Fatalf("cancel after reopen: %+v %v", final, e)
	}
}
func TestCockpitLifecycleUnschedule(t *testing.T) {
	f := lifecycleFixture(t)
	ctx := context.Background()
	p := lifecycleRead(f)
	h, e := f.issues.GetCockpitMeetingLifecycle(ctx, p)
	if e != nil {
		t.Fatal(e)
	}
	// A blank reason is refused before anything moves.
	unschedule := CockpitOccurrenceInput{CockpitLifecycleCommandInput: lifecycleInput(h.LifecycleRevision), Transition: "unschedule", Reason: "The schedule still needs work."}
	blank := unschedule
	blank.Reason = "   "
	if _, e = f.issues.ChangeCockpitMeetingOccurrence(ctx, p, blank); !errors.Is(e, ErrCockpitWorkflowInput) {
		t.Fatalf("reason-less unschedule: %v", e)
	}
	// Creation now confirms the schedule itself; the blank-reason refusal ran
	// against the fresh scheduled row directly.
	scheduled := h
	if scheduled.Occurrence.State != "scheduled" {
		t.Fatalf("created meeting is not scheduled: %+v", scheduled.Occurrence)
	}
	if !scheduled.CanUnschedule {
		t.Fatalf("scheduled meeting lost its reverse: %+v", scheduled)
	}
	undone, e := f.issues.ChangeCockpitMeetingOccurrence(ctx, p, unschedule)
	if e != nil {
		t.Fatal(e)
	}
	if undone.Current.Occurrence.State != "unconfirmed" || !undone.Current.CanSchedule || !undone.Current.CanEnd {
		t.Fatalf("unschedule lost its capabilities: %+v", undone.Current)
	}
	if undone.Receipt.PreviousOccurrence == nil || undone.Receipt.PreviousOccurrence.State != "scheduled" {
		t.Fatalf("unschedule dropped the recorded history: %+v", undone.Receipt)
	}
	again := unschedule
	again.CockpitLifecycleCommandInput = lifecycleInput(undone.Current.LifecycleRevision)
	if _, e = f.issues.ChangeCockpitMeetingOccurrence(ctx, p, again); !errors.Is(e, ErrCockpitWorkflowConflict) {
		t.Fatalf("unconfirmed unschedule: %v", e)
	}
	rescheduled, e := f.issues.ChangeCockpitMeetingOccurrence(ctx, p, CockpitOccurrenceInput{CockpitLifecycleCommandInput: lifecycleInput(undone.Current.LifecycleRevision), Transition: "schedule"})
	if e != nil || rescheduled.Current.Occurrence.State != "scheduled" {
		t.Fatalf("schedule after unschedule: %+v %v", rescheduled, e)
	}
	// R4 collapse: the start confirmation is gone; the measured start time goes
	// through correct_times while the meeting is still scheduled. The measured
	// end still waits for the confirmed end.
	started, _ := json.Marshal(time.Now().UTC().Add(-30 * time.Minute).Format(time.RFC3339Nano))
	corrected, e := f.issues.ChangeCockpitMeetingOccurrence(ctx, p, CockpitOccurrenceInput{CockpitLifecycleCommandInput: lifecycleInput(rescheduled.Current.LifecycleRevision), Transition: "correct_times", ActualStartedAt: started, Reason: "Backfilled the measured start."})
	if e != nil || corrected.Current.Occurrence.ActualStartedAt == nil || corrected.Current.Occurrence.State != "scheduled" {
		t.Fatalf("correct_times from scheduled: %+v %v", corrected, e)
	}
	// The ledger keeps both the withdrawal and the re-confirmation.
	key, _ := util.ParseUUID(unschedule.CommandKey)
	detail, e := f.issues.GetCockpitMeetingLifecycleCommand(ctx, p, key)
	if e != nil || detail.Action != "unschedule" || detail.Receipt.Reason != unschedule.Reason {
		t.Fatalf("unschedule ledger detail: %+v %v", detail, e)
	}
}
func TestCockpitScheduledCancellation(t *testing.T) {
	f := lifecycleFixture(t)
	ctx := context.Background()
	p := lifecycleRead(f)
	h, e := f.issues.GetCockpitMeetingLifecycle(ctx, p)
	if e != nil {
		t.Fatal(e)
	}
	scheduled := h
	if scheduled.Occurrence.State != "scheduled" {
		t.Fatalf("created meeting is not scheduled: %+v", scheduled.Occurrence)
	}
	// R4: a meeting inside its window is still "just scheduled" — no start
	// confirmation stands between the register and cancelling it.
	input := CockpitCancellationPreviewInput{Reason: "The meeting dissolved halfway."}
	plan, e := f.issues.PreviewCockpitMeetingCancellation(ctx, p, input)
	if e != nil || !plan.CanConfirm || plan.Intent != "cancel" {
		t.Fatalf("scheduled meeting cannot cancel: %+v %v", plan, e)
	}
	if _, e = f.issues.CancelCockpitMeeting(ctx, p, CockpitCancellationInput{CockpitLifecycleCommandInput: lifecycleInput(plan.LifecycleRevision), CockpitCancellationPreviewInput: input, ContextToken: plan.ContextToken}); e != nil {
		t.Fatal(e)
	}
	final, e := f.issues.GetCockpitMeetingLifecycle(ctx, p)
	if e != nil || final.Occurrence.State != "cancelled" || final.Occurrence.CancelledAt == nil || final.CanEnd {
		t.Fatalf("scheduled cancellation: %+v %v", final, e)
	}
	// An ended meeting still routes through reopen first.
	revived, e := f.issues.ChangeCockpitMeetingDisposition(ctx, p, CockpitMeetingDispositionInput{CockpitLifecycleCommandInput: lifecycleInput(final.LifecycleRevision), Transition: "reinstate", Reason: "Back on the calendar."})
	if e != nil {
		t.Fatal(e)
	}
	ended, e := f.issues.ChangeCockpitMeetingOccurrence(ctx, p, CockpitOccurrenceInput{CockpitLifecycleCommandInput: lifecycleInput(revived.Current.LifecycleRevision), Transition: "end"})
	if e != nil || ended.Current.Occurrence.State != "ended" {
		t.Fatalf("end before the blocked cancel: %+v %v", ended.Current, e)
	}
	blocked, e := f.issues.PreviewCockpitMeetingCancellation(ctx, p, input)
	if e != nil || blocked.CanConfirm {
		t.Fatalf("ended meeting cancelled without reopen: %+v %v", blocked, e)
	}
	found := false
	for _, reason := range blocked.BlockedReasons {
		if reason == "meeting_ended_reopen_first" {
			found = true
		}
	}
	if !found {
		t.Fatalf("ended cancel missing its reopen-first reason: %+v", blocked.BlockedReasons)
	}
}
