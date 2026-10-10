package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func lifecycleFixture(t *testing.T) cockpitWorkflowFixture {
	t.Helper()
	f := newCockpitWorkflowFixture(t)
	f.Cleanup(t, "DELETE FROM cockpit_meeting_agenda WHERE workspace_id=$1", f.ws)
	f.Cleanup(t, "DELETE FROM cockpit_meeting_agenda_reference WHERE workspace_id=$1", f.ws)
	f.Cleanup(t, "DELETE FROM cockpit_meeting_lifecycle_command WHERE workspace_id=$1", f.ws)
	return f
}
func lifecycleRead(f cockpitWorkflowFixture) CockpitLifecycleRead {
	return CockpitLifecycleRead{WorkspaceID: f.ws, MeetingID: f.meeting, ActorID: f.owner, Human: true}
}
func lifecycleInput(revision int64) CockpitLifecycleCommandInput {
	return CockpitLifecycleCommandInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: revision}
}
func lifecycleAgenda(t *testing.T, f cockpitWorkflowFixture, title, notes string) (CockpitLifecycleCommandResult, CockpitAgendaInput) {
	t.Helper()
	h, e := f.issues.GetCockpitMeetingLifecycle(context.Background(), lifecycleRead(f))
	if e != nil {
		t.Fatal(e)
	}
	in := CockpitAgendaInput{CockpitLifecycleCommandInput: lifecycleInput(h.AgendaRevision), Title: &title, Notes: &notes}
	out, e := f.issues.SaveCockpitMeetingAgenda(context.Background(), lifecycleRead(f), pgtype.UUID{}, in)
	if e != nil {
		t.Fatal(e)
	}
	return out, in
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
	if h.Occurrence.State != "unconfirmed" || h.WorkflowEnabled || h.Materials != nil {
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
	if _, e = f.Pool.Exec(ctx, "UPDATE cockpit_meeting SET ended_at=NULL,ended_source=NULL,occurrence_state='unconfirmed' WHERE workspace_id=$1 AND id=$2", f.ws, f.meeting); e == nil {
		t.Fatal("direct SQL reopened the recorded meeting")
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
	if f.work(t).Revision != 2 {
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
func TestCockpitLifecycleAgendaPagingExactReceiptsAndRemoveReplay(t *testing.T) {
	f := lifecycleFixture(t)
	ctx := context.Background()
	p := lifecycleRead(f)
	var first CockpitLifecycleCommandResult
	var original CockpitAgendaInput
	for i := 0; i < 31; i++ {
		r, in := lifecycleAgenda(t, f, fmt.Sprintf("Agenda %02d", i), strings.Repeat("bounded working record ", 2000))
		if i == 0 {
			first, original = r, in
		}
	}
	page, e := f.issues.ListCockpitMeetingAgenda(ctx, CockpitLifecycleList{CockpitLifecycleRead: p, PageSize: 25})
	if e != nil {
		t.Fatal(e)
	}
	if len(page.Items) != 25 || page.Total != 31 || page.NextCursor == nil {
		t.Fatalf("first bounded page: %+v", page)
	}
	b, _ := json.Marshal(page)
	if strings.Contains(string(b), "bounded working record") {
		t.Fatal("metadata page materialized notes")
	}
	second, e := f.issues.ListCockpitMeetingAgenda(ctx, CockpitLifecycleList{CockpitLifecycleRead: p, PageSize: 25, Cursor: *page.NextCursor})
	if e != nil || len(second.Items) != 6 || second.NextCursor != nil {
		t.Fatalf("second page %d: %v", len(second.Items), e)
	}
	id := mustLifecycleUUID(first.Receipt.AgendaID)
	notes := "A peer amended this draft."
	edit, e := f.issues.SaveCockpitMeetingAgenda(ctx, p, id, CockpitAgendaInput{CockpitLifecycleCommandInput: lifecycleInput(1), Notes: &notes})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.issues.ListCockpitMeetingAgenda(ctx, CockpitLifecycleList{CockpitLifecycleRead: p, PageSize: 25, Cursor: *page.NextCursor}); !errors.Is(e, ErrCockpitWorkflowConflict) {
		t.Fatalf("stale cursor accepted: %v", e)
	}
	replay, e := f.issues.SaveCockpitMeetingAgenda(ctx, p, pgtype.UUID{}, original)
	if e != nil || !replay.Replayed || replay.Receipt.Agenda.Notes == notes {
		t.Fatalf("create replay inferred current body: %+v %v", replay, e)
	}
	remove := CockpitAgendaRemoveInput{CockpitLifecycleCommandInput: lifecycleInput(edit.Receipt.Revision), Reason: "Superseded agenda item"}
	removed, e := f.issues.RemoveCockpitMeetingAgenda(ctx, p, id, remove)
	if e != nil {
		t.Fatal(e)
	}
	replay, e = f.issues.RemoveCockpitMeetingAgenda(ctx, p, id, remove)
	if e != nil || !replay.Replayed || replay.Receipt.Agenda.RemovedAt == nil || replay.Receipt.Revision != removed.Receipt.Revision {
		t.Fatalf("remove's terminal replay refused: %+v %v", replay, e)
	}
	if _, e = f.Pool.Exec(ctx, "DELETE FROM cockpit_meeting_agenda WHERE workspace_id=$1 AND id=$2", f.ws, id); e != nil {
		t.Fatal(e)
	}
	if replay, e = f.issues.RemoveCockpitMeetingAgenda(ctx, p, id, remove); e != nil || !replay.Replayed {
		t.Fatalf("purged removed row hid terminal receipt: %+v %v", replay, e)
	}
	if _, e = f.issues.SaveCockpitMeetingAgenda(ctx, p, pgtype.UUID{}, original); !errors.Is(e, ErrCockpitLifecycleGone) {
		t.Fatalf("old create revived removed agenda: %v", e)
	}
	foreign := p
	foreign.WorkspaceID = dbid.NewV7()
	if _, e = f.issues.GetCockpitMeetingAgenda(ctx, foreign, id); !errors.Is(e, ErrCockpitWorkflowForbidden) {
		t.Fatalf("cross-workspace agenda: %v", e)
	}
}
func TestCockpitLifecyclePreparationCreatesOneUnassignedBacklogIssue(t *testing.T) {
	f := lifecycleFixture(t)
	ctx := context.Background()
	p := lifecycleRead(f)
	a, _ := lifecycleAgenda(t, f, "Prepare evidence", "")
	agenda := mustLifecycleUUID(a.Receipt.AgendaID)
	in := CockpitPreparationIssueInput{CockpitLifecycleCommandInput: lifecycleInput(1), NewIssue: CockpitPreparationIssueFields{Title: "Gather material", Description: "Use only available evidence", Priority: "none"}}
	var wg sync.WaitGroup
	results := make(chan CockpitLifecycleCommandResult, 2)
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out, e := f.issues.CreateCockpitMeetingPreparationIssue(ctx, p, agenda, in, IssueCreateOpts{})
			results <- out
			errs <- e
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	var id string
	for r := range results {
		if r.Receipt.IssueID == nil {
			t.Fatal("missing exact issue receipt")
		}
		if id != "" && id != *r.Receipt.IssueID {
			t.Fatal("one command created two issues")
		}
		id = *r.Receipt.IssueID
	}
	issueID, _ := util.ParseUUID(id)
	issue, e := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: issueID})
	if e != nil {
		t.Fatal(e)
	}
	if issue.Status != "backlog" || issue.AssigneeID.Valid || issue.AssigneeType.Valid {
		t.Fatalf("implicit executor or run state: %+v", issue)
	}
	refs, e := f.issues.ListCockpitMeetingAgendaReferences(ctx, CockpitLifecycleList{CockpitLifecycleRead: p, AgendaID: agenda, PageSize: 25})
	if e != nil || refs.Total != 1 || !refs.Items[0].Available {
		t.Fatalf("preparation reference: %+v %v", refs, e)
	}
	reverse, e := f.issues.ListCockpitIssueMeetingReferences(ctx, f.ws, issueID, "", 25)
	if e != nil || len(reverse.Items) != 1 || reverse.Items[0].HasDirectReference || !reverse.Items[0].HasAgendaReference || reverse.Items[0].CanUnlink {
		t.Fatalf("derived reverse relationship: %+v %v", reverse, e)
	}
	var runs int
	if e = f.Pool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issueID).Scan(&runs); e != nil || runs != 0 {
		t.Fatalf("preparation dispatched: %d %v", runs, e)
	}
	if _, e = f.Pool.Exec(ctx, "DELETE FROM issue WHERE workspace_id=$1 AND id=$2", f.ws, issueID); e != nil {
		t.Fatal(e)
	}
	if _, e = f.issues.CreateCockpitMeetingPreparationIssue(ctx, p, agenda, in, IssueCreateOpts{}); !errors.Is(e, ErrCockpitLifecycleGone) {
		t.Fatalf("deleted preparation recreated: %v", e)
	}
}

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
	if h.LifecycleRevision != 2 || h.Materials.WorkflowRevision != 2 || h.Occurrence.EndedAt == nil || h.Occurrence.ActualEndedAt != nil {
		t.Fatalf("racing end split authority: %+v", h)
	}
}
func TestCockpitLifecycleAgendaL3AndFixedArtifactReferences(t *testing.T) {
	f := newArtifactFixture(t)
	ctx := context.Background()
	f.Cleanup(t, "DELETE FROM cockpit_meeting_agenda WHERE workspace_id=$1", f.ws)
	f.Cleanup(t, "DELETE FROM cockpit_meeting_agenda_reference WHERE workspace_id=$1", f.ws)
	f.Cleanup(t, "DELETE FROM cockpit_meeting_lifecycle_command WHERE workspace_id=$1", f.ws)
	p := lifecycleRead(f.cockpitWorkflowFixture)
	title := "Discuss fixed results"
	node, _ := json.Marshal(util.UUIDToString(f.a))
	a, e := f.issues.SaveCockpitMeetingAgenda(ctx, p, pgtype.UUID{}, CockpitAgendaInput{CockpitLifecycleCommandInput: lifecycleInput(1), Title: &title, NodeID: node})
	if e != nil {
		t.Fatal(e)
	}
	id := mustLifecycleUUID(a.Receipt.AgendaID)
	version, e := f.issues.SubmitCockpitArtifactVersion(ctx, f.submission(t, "Fixed discussion material awaiting review"), IssueCreateOpts{})
	if e != nil {
		t.Fatal(e)
	}
	ref, e := f.issues.CreateCockpitArtifactReference(ctx, CockpitArtifactReferenceCommand{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ArtifactID: f.artifact, ActorID: f.owner, Human: true}, ReferenceKey: dbid.NewV7(), VersionID: version, MeetingID: f.meeting, Purpose: "input"}, "meeting")
	if e != nil {
		t.Fatal(e)
	}
	attach := CockpitAgendaReferenceInput{CockpitLifecycleCommandInput: lifecycleInput(1), Kind: "artifact_reference", TargetID: ref.Reference.ID, Purpose: "material"}
	linked, e := f.issues.AttachCockpitAgendaReference(ctx, p, id, attach)
	if e != nil {
		t.Fatal(e)
	}
	fixed := linked.Receipt.Reference
	if !fixed.Available || fixed.ArtifactID == nil || *fixed.ArtifactID != util.UUIDToString(f.artifact) || fixed.VersionID == nil || *fixed.VersionID != util.UUIDToString(version) || fixed.ContentHash == nil || fixed.VersionDecision == nil || *fixed.VersionDecision != "pending" {
		t.Fatalf("fixed reference lost its source: %+v", fixed)
	}
	f.review(t, version, "approved")
	newer, e := f.issues.SubmitCockpitArtifactVersion(ctx, f.submission(t, "A newer pending working version"), IssueCreateOpts{})
	if e != nil {
		t.Fatal(e)
	}
	refs, e := f.issues.ListCockpitMeetingAgendaReferences(ctx, CockpitLifecycleList{CockpitLifecycleRead: p, AgendaID: id, PageSize: 25})
	if e != nil || len(refs.Items) != 1 || refs.Items[0].VersionDecision == nil || *refs.Items[0].VersionDecision != "approved" || *refs.Items[0].VersionID != util.UUIDToString(version) || *refs.Items[0].VersionID == util.UUIDToString(newer) || *refs.Items[0].ContentHash != *fixed.ContentHash {
		t.Fatalf("fixed material was replaced by latest artifact version: %+v %v", refs, e)
	}
	materialPage, e := f.issues.ListCockpitMeetingArtifactReferences(ctx, CockpitMeetingArtifactReferencesRead{WorkspaceID: f.ws, ActorID: f.owner, MeetingID: f.meeting, Human: true, PageSize: 25})
	if e != nil || len(materialPage.Items) != 1 || materialPage.Items[0].VersionDecision == nil || *materialPage.Items[0].VersionDecision != "approved" || materialPage.Items[0].VersionID != util.UUIDToString(version) {
		t.Fatalf("resources selector used the latest version decision: %+v %v", materialPage, e)
	}
	prep := CockpitPreparationIssueInput{CockpitLifecycleCommandInput: lifecycleInput(linked.Receipt.Revision), PrimaryNodeID: planningUUID(f.a), NewIssue: CockpitPreparationIssueFields{Title: "Prepare follow-up evidence", Priority: "none"}}
	made, e := f.issues.CreateCockpitMeetingPreparationIssue(ctx, p, id, prep, IssueCreateOpts{})
	if e != nil {
		t.Fatal(e)
	}
	issue := made.Receipt.Reference.Issue
	if issue.PrimaryNodeID == nil || *issue.PrimaryNodeID != util.UUIDToString(f.a) || issue.ProjectID == nil || *issue.ProjectID != util.UUIDToString(f.project) || issue.ModuleID == nil || *issue.ModuleID != util.UUIDToString(f.module) {
		t.Fatalf("preparation ignored the selected leaf scope: %+v", issue)
	}
	if _, e = f.Pool.Exec(ctx, "UPDATE cockpit_meeting SET meet_date='2026-10-09' WHERE workspace_id=$1 AND id=$2", f.ws, f.meeting); e != nil {
		t.Fatal(e)
	}
	f.Cleanup(t, "DELETE FROM cockpit_meeting_node WHERE workspace_id=$1", f.ws)
	if _, e = f.Pool.Exec(ctx, "INSERT INTO cockpit_meeting_node(workspace_id,meeting_id,node_id,position) VALUES($1,$2,$3,0)", f.ws, f.meeting, f.a); e != nil {
		t.Fatal(e)
	}
	markers, e := f.issues.GetCockpitPlanMeetingMarkers(ctx, CockpitPlanMarkerQuery{CockpitSurfaceQuery: CockpitSurfaceQuery{WorkspaceID: f.ws, ActorID: f.owner, ProjectID: f.project, ModuleID: f.module, Human: true}, Rows: []CockpitPlanMarkerRow{{RowKey: util.UUIDToString(f.a), NodeIDs: []string{util.UUIDToString(f.a)}}}, DateFrom: "2026-10-01", DateTo: "2026-10-31"})
	if e != nil || len(markers.Groups) != 1 || markers.Groups[0].Total != 1 {
		t.Fatalf("agenda plus direct reference double-counted marker: %+v %v", markers, e)
	}
	page, e := f.issues.ListCockpitMeetingRegister(ctx, CockpitMeetingRegisterQuery{CockpitSurfaceQuery: CockpitSurfaceQuery{WorkspaceID: f.ws, ActorID: f.owner, ProjectID: f.project, ModuleID: f.module, Human: true}, PageSize: 25})
	if e != nil || page.Total != 1 {
		t.Fatalf("agenda meeting disappeared in target project/module: %+v %v", page, e)
	}
	if _, e = f.issues.GetCockpitSurfaceMeeting(ctx, CockpitSurfaceQuery{WorkspaceID: f.ws, ActorID: f.owner, ProjectID: f.project, ModuleID: f.module, Human: true}, f.meeting); e != nil {
		t.Fatalf("agenda exact scope cannot open meeting: %v", e)
	}
}
