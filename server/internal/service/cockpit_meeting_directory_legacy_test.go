package service

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"

	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func legacyDirectoryFixture(t *testing.T, allowed bool) (cockpitWorkflowFixture, CockpitDirectoryRead, string, string) {
	t.Helper()
	f := lifecycleFixture(t)
	root := t.TempDir()
	rid := util.UUIDToString(dbid.NewV7())
	cfg := cockpitnas.Root{WorkspaceID: util.UUIDToString(f.ws), RootID: rid, Path: root, AllowLocal: true, WriteMode: cockpitnas.ModeCreateOnly}
	if allowed {
		cfg.PrepareSubpaths = []string{"."}
	}
	raw, err := json.Marshal([]cockpitnas.Root{cfg})
	if err != nil {
		t.Fatal(err)
	}
	provider, err := cockpitnas.New(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, cockpitnas.MarkerName), []byte(rid+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	f.issues.CockpitMeetingDirectoryBackendReady = true
	f.issues.CockpitDirectoryPreparer = provider
	for _, table := range []string{"cockpit_meeting_directory_operation", "cockpit_meeting_directory_step", "cockpit_meeting_directory_attempt"} {
		f.Cleanup(t, "DELETE FROM "+table+" WHERE workspace_id=$1", f.ws)
	}
	return f, CockpitDirectoryRead{WorkspaceID: f.ws, MeetingID: f.meeting, CredentialOwnerID: f.owner, ActorSource: "human"}, root, rid
}
func TestCockpitDirectoryLegacyReusesCompletedPlanAndExplicitlyRepairsMissingPartition(t *testing.T) {
	f, p, root, _ := legacyDirectoryFixture(t, true)
	ctx := context.Background()
	input := CockpitLegacyDirectoryInput{Directory: filepath.Join(root, "Fixed meeting")}
	first, err := f.issues.ProvisionCockpitMeetingDirectory(ctx, p, input)
	if err != nil || first.State != "completed" || !first.BaseReady || first.ErrorMessage != "" || first.OperationID == "" {
		t.Fatalf("first legacy result: %+v %v", first, err)
	}
	id := parseTestUUID(t, first.OperationID)
	before, err := f.q.GetCockpitDirectoryOperation(ctx, db.GetCockpitDirectoryOperationParams{WorkspaceID: f.ws, MeetingID: f.meeting, ID: id})
	if err != nil {
		t.Fatal(err)
	}
	var attemptsBefore int64
	if err = f.Pool.QueryRow(ctx, "SELECT count(*) FROM cockpit_meeting_directory_attempt WHERE workspace_id=$1", f.ws).Scan(&attemptsBefore); err != nil {
		t.Fatal(err)
	}
	// A name change is not a new target, and the operation's own base-binding CAS
	// must not change the natural plan identity used by an older client.
	if _, err = f.Pool.Exec(ctx, "UPDATE cockpit_meeting SET title='Renamed after preparation' WHERE workspace_id=$1 AND id=$2", f.ws, f.meeting); err != nil {
		t.Fatal(err)
	}
	second, err := f.issues.ProvisionCockpitMeetingDirectory(ctx, p, input)
	if err != nil || second.OperationID != first.OperationID || !second.BaseReady || second.State != "completed" {
		t.Fatalf("same target replay: %+v %v", second, err)
	}
	var attemptsAfter int64
	if err = f.Pool.QueryRow(ctx, "SELECT count(*) FROM cockpit_meeting_directory_attempt WHERE workspace_id=$1", f.ws).Scan(&attemptsAfter); err != nil || attemptsAfter != attemptsBefore {
		t.Fatalf("completed replay repeated writes: %d -> %d %v", attemptsBefore, attemptsAfter, err)
	}
	partition := filepath.Join(input.Directory, "照片")
	if err = os.Remove(partition); err != nil {
		t.Fatal(err)
	}
	repair, err := f.issues.ProvisionCockpitMeetingDirectory(ctx, p, input)
	if err != nil || repair.OperationID == first.OperationID || repair.OperationID == "" || repair.State != "completed" || !repair.BaseReady {
		t.Fatalf("explicit legacy repair: %+v %v", repair, err)
	}
	if info, err := os.Stat(partition); err != nil || !info.IsDir() {
		t.Fatal("repair did not restore the selected fixed partition")
	}
	after, err := f.q.GetCockpitDirectoryOperation(ctx, db.GetCockpitDirectoryOperationParams{WorkspaceID: f.ws, MeetingID: f.meeting, ID: id})
	if err != nil || string(after.Receipt) != string(before.Receipt) || after.State != before.State || after.Revision != before.Revision {
		t.Fatal("repair rewrote the original completion receipt")
	}
	// The same physical target is not the same binding authorization after
	// somebody explicitly chooses another directory. Rebinding needs a new plan.
	other := filepath.Join(root, "Another binding")
	if err := os.Mkdir(other, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Pool.Exec(ctx, "UPDATE cockpit_meeting SET nas_dir=$1 WHERE workspace_id=$2 AND id=$3", other, f.ws, f.meeting); err != nil {
		t.Fatal(err)
	}
	rebound, err := f.issues.ProvisionCockpitMeetingDirectory(ctx, p, input)
	if err != nil || rebound.OperationID == repair.OperationID || rebound.State != "completed" || !rebound.BaseReady {
		t.Fatalf("explicit rebinding reused old authority: %+v %v", rebound, err)
	}
	current, err := f.q.GetCockpitMeeting(ctx, db.GetCockpitMeetingParams{WorkspaceID: f.ws, ID: f.meeting})
	if err != nil || current.NasDir != input.Directory {
		t.Fatalf("new binding was not confirmed: %q %v", current.NasDir, err)
	}
	var issues, runs int64
	if err = f.Pool.QueryRow(ctx, "SELECT count(*) FROM issue WHERE workspace_id=$1", f.ws).Scan(&issues); err != nil {
		t.Fatal(err)
	}
	if err = f.Pool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue q JOIN issue i ON i.id=q.issue_id WHERE i.workspace_id=$1", f.ws).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if issues != 0 || runs != 0 {
		t.Fatal("directory preparation created Issue or Agent work")
	}
}
func TestCockpitDirectoryLegacyMissingScopeAndCloudCredentialCannotWrite(t *testing.T) {
	f, p, root, _ := legacyDirectoryFixture(t, false)
	input := CockpitLegacyDirectoryInput{Directory: filepath.Join(root, "Not authorized")}
	for _, source := range []string{"human", "cloud_pat"} {
		p.ActorSource = source
		_, err := f.issues.ProvisionCockpitMeetingDirectory(context.Background(), p, input)
		var typed *CockpitDirectoryError
		want := "prepare_not_configured"
		if source == "cloud_pat" {
			want = "task_context_required"
		}
		if !errors.As(err, &typed) || typed.Code != want {
			t.Fatalf("%s: expected %s, got %v", source, want, err)
		}
	}
	if _, err := os.Stat(input.Directory); !os.IsNotExist(err) {
		t.Fatal("legacy command created an unauthorized directory")
	}
	var count int64
	if err := f.Pool.QueryRow(context.Background(), "SELECT count(*) FROM cockpit_meeting_directory_operation WHERE workspace_id=$1", f.ws).Scan(&count); err != nil || count != 0 {
		t.Fatalf("unauthorized operation count=%d err=%v", count, err)
	}
}

func TestCockpitDirectoryLegacyConcurrentRequestsKeepOneNaturalPlan(t *testing.T) {
	f, p, root, _ := legacyDirectoryFixture(t, true)
	input := CockpitLegacyDirectoryInput{Directory: filepath.Join(root, "Concurrent meeting")}
	results := make([]CockpitLegacyDirectoryResult, 2)
	errorsByCall := make([]error, 2)
	var group sync.WaitGroup
	start := make(chan struct{})
	for i := range results {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			<-start
			results[index], errorsByCall[index] = f.issues.ProvisionCockpitMeetingDirectory(context.Background(), p, input)
		}(i)
	}
	close(start)
	group.Wait()
	for i, out := range results {
		if errorsByCall[i] != nil || out.OperationID == "" || out.OperationID != results[0].OperationID {
			t.Fatalf("concurrent request %d: %+v %v", i, out, errorsByCall[i])
		}
		if out.State != "completed" && out.ErrorMessage == "" {
			t.Fatal("partial directory work was reported as fully successful")
		}
	}
	final, err := f.issues.ProvisionCockpitMeetingDirectory(context.Background(), p, input)
	if err != nil || final.OperationID != results[0].OperationID || final.State != "completed" || !final.BaseReady {
		t.Fatalf("final read/advance: %+v %v", final, err)
	}
	var count int64
	if err := f.Pool.QueryRow(context.Background(), "SELECT count(*) FROM cockpit_meeting_directory_operation WHERE workspace_id=$1", f.ws).Scan(&count); err != nil || count != 1 {
		t.Fatalf("natural plan count=%d error=%v", count, err)
	}
}

func TestCockpitDirectoryLegacyMachineNaturalReuseRequiresOriginalAuthority(t *testing.T) {
	f, _, root, rid := legacyDirectoryFixture(t, true)
	ctx := context.Background()
	credentialOwner := f.member(t, "legacy-runtime-owner")
	runtime := f.Runtime(t, "Legacy directory runtime", testutil.Cols{"owner_id": credentialOwner, "visibility": "public"})
	agent := f.Agent(t, "Legacy directory producer", runtime, testutil.Cols{"owner_id": f.owner, "permission_mode": "private", "status": "idle"})
	issue := f.Issue(t, "Exact preparation source")
	otherIssue := f.Issue(t, "Unrelated source")
	otherUser := parseTestUUID(t, f.member(t, "different-originator"))
	f.InsertNoID(t, "cockpit_meeting_issue", testutil.Cols{"workspace_id": f.ws, "meeting_id": f.meeting, "issue_id": issue, "role": "task", "roles": []string{"preparation"}}, "workspace_id=$1 AND meeting_id=$2 AND issue_id=$3", f.ws, f.meeting, issue)
	principal := func(source string, authorizer pgtype.UUID) CockpitDirectoryRead {
		run := f.Task(t, agent, testutil.Cols{"issue_id": source, "runtime_id": runtime, "status": "running", "originator_user_id": authorizer, "accountable_user_id": authorizer})
		token, err := f.q.CreateTaskToken(ctx, db.CreateTaskTokenParams{ID: dbid.NewV7(), TokenHash: util.UUIDToString(dbid.NewV7()), TaskID: parseTestUUID(t, run), AgentID: parseTestUUID(t, agent), WorkspaceID: f.ws, UserID: parseTestUUID(t, credentialOwner), ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		if err != nil {
			t.Fatal(err)
		}
		f.Cleanup(t, "DELETE FROM task_token WHERE id=$1", token.ID)
		return CockpitDirectoryRead{WorkspaceID: f.ws, MeetingID: f.meeting, CredentialOwnerID: parseTestUUID(t, credentialOwner), ActorSource: "task_token", AgentID: parseTestUUID(t, agent), RunID: parseTestUUID(t, run), TaskTokenID: token.ID}
	}
	original := principal(issue, f.owner)
	made, _ := directoryCreateFixturePlan(t, f, original, rid, "natural-authority", []string{"会议纪要与录音转写", "会议材料", "照片"})
	input := CockpitLegacyDirectoryInput{Directory: filepath.Join(root, "natural-authority")}
	for _, p := range []CockpitDirectoryRead{principal(issue, otherUser), principal(otherIssue, f.owner)} {
		result, err := f.issues.ProvisionCockpitMeetingDirectory(ctx, p, input)
		if !errors.Is(err, ErrCockpitWorkflowForbidden) {
			t.Fatalf("different source reused another person's natural authorization: %+v %v", result, err)
		}
	}
	if _, err := os.Stat(input.Directory); !os.IsNotExist(err) {
		t.Fatal("a different originator or source Issue drove the accepted plan")
	}
	next := principal(issue, f.owner)
	if _, err := f.Pool.Exec(ctx, "UPDATE agent_task_queue SET status='completed' WHERE id=ANY($1::uuid[])", []string{util.UUIDToString(original.RunID), util.UUIDToString(next.RunID)}); err != nil {
		t.Fatal(err)
	}
	completed, err := f.issues.ProvisionCockpitMeetingDirectory(ctx, next, input)
	if err != nil || completed.OperationID != made.Current.ID || completed.State != "completed" || !completed.BaseReady {
		t.Fatalf("same authority lost recovery after source Run ended: %+v %v", completed, err)
	}
}
