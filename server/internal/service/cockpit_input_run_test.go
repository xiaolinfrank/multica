package service

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestCockpitInputRunRequiresExactPreparationBeforeStartAndAfterReclaim(t *testing.T) {
	f, s, q := inputManifestFixture(t)
	ctx := context.Background()
	file := inputManifestReadyFile(t, s, q.CockpitInputRead, "required fixed bytes")
	optional := inputManifestReadyFile(t, s, q.CockpitInputRead, "optional supporting bytes")
	saved, err := s.SaveCockpitInputManifest(ctx, q, CockpitInputManifestSaveInput{CommandKey: util.UUIDToString(dbid.NewV7()), Items: []CockpitInputManifestItemInput{{InputVersionID: util.UUIDToString(file.VersionID), Purpose: "material", Required: true}, {InputVersionID: util.UUIDToString(optional.VersionID), Purpose: "supporting"}}})
	if err != nil {
		t.Fatal(err)
	}
	runtime, agent := inputManifestTaskAgent(t, f, q.CockpitInputRead, q.IssueID)
	tasks := NewTaskService(f.q, f.Pool, nil, s.Bus)
	issue, err := f.q.GetIssue(ctx, q.IssueID)
	if err != nil {
		t.Fatal(err)
	}
	queued, err := tasks.EnqueueTaskForIssueByActor(ctx, issue, q.CredentialOwnerID)
	if err != nil {
		t.Fatal(err)
	}
	claimArgs := db.ClaimAgentTaskParams{AgentID: agent, RuntimeID: runtime, PrepareLeaseSecs: 45, RuntimeStaleSecs: 150}
	if _, err = f.q.ClaimAgentTask(ctx, claimArgs); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("old daemon claimed fixed inputs: %v", err)
	}
	claimArgs.SupportsFixedInputManifests = true
	claimed, err := f.q.ClaimAgentTask(ctx, claimArgs)
	if err != nil || claimed.ID != queued.ID {
		t.Fatalf("capable daemon claim: %+v %v", claimed, err)
	}
	claim := db.LockAgentTaskStartClaimParams{ID: claimed.ID, RuntimeID: runtime, DispatchedAt: claimed.DispatchedAt}
	if _, err = tasks.StartTaskForClaim(WithInputClaimCredentialOwner(ctx, q.CredentialOwnerID), claim); inputErrorCode(err) != "input_preparation_required" {
		t.Fatalf("task started before bytes were prepared: %v", err)
	}
	p := CockpitInputQuery{CockpitInputRead: CockpitInputRead{WorkspaceID: q.WorkspaceID, CredentialOwnerID: q.CredentialOwnerID, AgentID: agent, RunID: claimed.ID, RuntimeID: runtime, ClaimDispatchedAt: claimed.DispatchedAt, ActorSource: "daemon_claim"}, TaskID: claimed.ID}
	ack := CockpitRunInputPreparationInput{ManifestVersionID: saved.Receipt.ManifestVersionID, ManifestHash: saved.Receipt.ManifestHash, DispatchedAt: claimed.DispatchedAt.Time.Format(time.RFC3339Nano), State: "required_ready", PreparedInputVersionIDs: []string{}}
	if _, err = s.RecordCockpitRunInputPreparation(ctx, p, ack); inputErrorCode(err) != "input_preparation_incomplete" {
		t.Fatalf("missing required input accepted: %v", err)
	}
	ack.PreparedInputVersionIDs = []string{util.UUIDToString(dbid.NewV7())}
	if _, err = s.RecordCockpitRunInputPreparation(ctx, p, ack); inputErrorCode(err) != "input_manifest_changed" {
		t.Fatalf("foreign version accepted as prepared: %v", err)
	}
	ack.PreparedInputVersionIDs = []string{util.UUIDToString(file.VersionID)}
	prepared, err := s.RecordCockpitRunInputPreparation(ctx, p, ack)
	if err != nil || prepared.PreparationState != "required_ready" || prepared.ManifestVersion == nil || prepared.ManifestVersion.ID != saved.Receipt.ManifestVersionID || !prepared.RuntimeSupported {
		t.Fatalf("exact required subset preparation: %+v %v", prepared, err)
	}
	if _, err = f.Pool.Exec(ctx, "UPDATE agent_task_queue SET prepare_lease_expires_at=now()-interval '1 minute' WHERE id=$1", claimed.ID); err != nil {
		t.Fatal(err)
	}
	reclaimed, err := f.q.ReclaimStaleDispatchedTaskForRuntime(ctx, db.ReclaimStaleDispatchedTaskForRuntimeParams{RuntimeID: runtime, ClaimRecoverySecs: 0, PrepareLeaseSecs: 45, RuntimeStaleSecs: 150, SupportsFixedInputManifests: true})
	if err != nil || reclaimed.InputPreparationState != "pending" || reclaimed.InputPreparationHash.Valid || reclaimed.InputPreparedAt.Valid || reclaimed.InputManifestVersionID != claimed.InputManifestVersionID {
		t.Fatalf("new dispatch reused old readiness: %+v %v", reclaimed, err)
	}
	if _, err = s.RecordCockpitRunInputPreparation(ctx, p, ack); err == nil {
		t.Fatal("old dispatch ACK was accepted after reclaim")
	}
	if _, err = tasks.StartTaskForClaim(WithInputClaimCredentialOwner(ctx, q.CredentialOwnerID), claim); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("old dispatch started new claim: %v", err)
	}
	p.ClaimDispatchedAt = reclaimed.DispatchedAt
	ack.DispatchedAt = reclaimed.DispatchedAt.Time.Format(time.RFC3339Nano)
	if _, err = s.RecordCockpitRunInputPreparation(ctx, p, ack); err != nil {
		t.Fatal(err)
	}
	claim.DispatchedAt = reclaimed.DispatchedAt
	started, err := tasks.StartTaskForClaim(WithInputClaimCredentialOwner(ctx, q.CredentialOwnerID), claim)
	if err != nil || started.Status != "running" {
		t.Fatalf("prepared exact claim did not start: %+v %v", started, err)
	}
	// A lost ACK can be read/repeated after Start without inventing a new Run.
	if _, err = s.RecordCockpitRunInputPreparation(ctx, p, ack); err != nil {
		t.Fatalf("exact accepted ACK recovery: %v", err)
	}
	if _, err = f.Pool.Exec(ctx, "UPDATE agent_task_queue SET status='failed' WHERE id=$1", claimed.ID); err != nil {
		t.Fatal(err)
	}
	retry, err := f.q.CreateRetryTask(ctx, db.CreateRetryTaskParams{ID: claimed.ID})
	if err != nil || retry.InputManifestVersionID != claimed.InputManifestVersionID || retry.InputPreparationState != "pending" || retry.InputPreparationHash.Valid || retry.InputPreparedAt.Valid || retry.InputPreparedDispatchedAt.Valid {
		t.Fatalf("automatic retry did not retain pin/reset readiness: %+v %v", retry, err)
	}
}

func TestCockpitInputRunExplicitNullPreconditionDoesNotCancelPendingTask(t *testing.T) {
	f, s, q := inputManifestFixture(t)
	ctx := context.Background()
	_, _ = inputManifestTaskAgent(t, f, q.CockpitInputRead, q.IssueID)
	tasks := NewTaskService(f.q, f.Pool, nil, s.Bus)
	first, err := tasks.RerunIssue(ctx, q.IssueID, pgtype.UUID{}, pgtype.UUID{}, q.CredentialOwnerID, nil, pgtype.UUID{})
	if err != nil || first.InputManifestVersionID.Valid {
		t.Fatalf("explicit no-manifest authorization: %+v %v", first, err)
	}
	inputManifestSaveEmpty(t, s, q, 0)
	if _, err = tasks.RerunIssue(ctx, q.IssueID, pgtype.UUID{}, pgtype.UUID{}, q.CredentialOwnerID, nil, pgtype.UUID{}); inputErrorCode(err) != "input_manifest_changed" {
		t.Fatalf("explicit null confused with omitted: %v", err)
	}
	prior, err := f.q.GetAgentTask(ctx, first.ID)
	if err != nil || prior.Status != "queued" {
		t.Fatalf("failed explicit-null authorization cancelled queued task: %+v %v", prior, err)
	}
}

func TestCockpitInputRunPreparationRechecksAuthorityAfterRuntimeLockWait(t *testing.T) {
	for _, action := range []string{"ack", "start"} {
		t.Run(action, func(t *testing.T) {
			f, s, q := inputManifestFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			manifest := inputManifestSaveEmpty(t, s, q, 0)
			runtime, agent := inputManifestTaskAgent(t, f, q.CockpitInputRead, q.IssueID)
			other := parseTestUUID(t, f.member(t, "changed-run-originator"))
			tasks := NewTaskService(f.q, f.Pool, nil, s.Bus)
			issue, err := f.q.GetIssue(ctx, q.IssueID)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = tasks.EnqueueTaskForIssueByActor(ctx, issue, q.CredentialOwnerID); err != nil {
				t.Fatal(err)
			}
			task, err := f.q.ClaimAgentTask(ctx, db.ClaimAgentTaskParams{AgentID: agent, RuntimeID: runtime, PrepareLeaseSecs: 45, RuntimeStaleSecs: 150, SupportsFixedInputManifests: true})
			if err != nil {
				t.Fatal(err)
			}
			row, err := f.q.GetCockpitInputManifestVersion(ctx, db.GetCockpitInputManifestVersionParams{WorkspaceID: q.WorkspaceID, IssueID: q.IssueID, ID: manifest})
			if err != nil {
				t.Fatal(err)
			}
			p := CockpitInputQuery{CockpitInputRead: CockpitInputRead{WorkspaceID: q.WorkspaceID, CredentialOwnerID: q.CredentialOwnerID, AgentID: agent, RunID: task.ID, RuntimeID: runtime, ClaimDispatchedAt: task.DispatchedAt, ActorSource: "daemon_claim"}, TaskID: task.ID}
			ack := CockpitRunInputPreparationInput{ManifestVersionID: util.UUIDToString(manifest), ManifestHash: row.ManifestHash, DispatchedAt: inputTime(task.DispatchedAt), State: "required_ready", PreparedInputVersionIDs: []string{}}
			if action == "start" {
				if _, err = s.RecordCockpitRunInputPreparation(ctx, p, ack); err != nil {
					t.Fatal(err)
				}
			}
			holder, err := f.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback(context.Background())
			var holderPID int32
			if err = holder.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&holderPID); err != nil {
				t.Fatal(err)
			}
			if _, err = holder.Exec(ctx, "SELECT id FROM agent_runtime WHERE id=$1 FOR UPDATE", runtime); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				if action == "ack" {
					_, e := s.RecordCockpitRunInputPreparation(ctx, p, ack)
					done <- e
				} else {
					_, e := tasks.StartTaskForClaim(WithInputClaimCredentialOwner(ctx, q.CredentialOwnerID), db.LockAgentTaskStartClaimParams{ID: task.ID, RuntimeID: runtime, DispatchedAt: task.DispatchedAt})
					done <- e
				}
			}()
			ticker := time.NewTicker(5 * time.Millisecond)
			defer ticker.Stop()
			for {
				var waiting bool
				if err = f.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)))", holderPID).Scan(&waiting); err != nil {
					t.Fatal(err)
				}
				if waiting {
					break
				}
				select {
				case e := <-done:
					t.Fatalf("preparation bypassed authorization lock: %v", e)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-ticker.C:
				}
			}
			if _, err = f.Pool.Exec(ctx, "UPDATE agent_task_queue SET originator_user_id=$2,accountable_user_id=$2 WHERE id=$1", task.ID, other); err != nil {
				t.Fatal(err)
			}
			if err = holder.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err = <-done; inputErrorCode(err) != "source_run_unavailable" {
				t.Fatalf("changed Run authority crossed lock wait: %v", err)
			}
			current, err := f.q.GetAgentTask(ctx, task.ID)
			if err != nil || current.Status != "dispatched" || action == "ack" && current.InputPreparationState != "pending" {
				t.Fatalf("stale authority mutated task: %+v %v", current, err)
			}
		})
	}
}

func TestCockpitInputRunAuthorizationDoesNotDeadlockCanonicalOwnerFence(t *testing.T) {
	f, s, q := inputManifestFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	manifest := inputManifestSaveEmpty(t, s, q, 0)
	runtime, agent := inputManifestTaskAgent(t, f, q.CockpitInputRead, q.IssueID)
	tasks := NewTaskService(f.q, f.Pool, nil, s.Bus)
	issue, err := f.q.GetIssue(ctx, q.IssueID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tasks.EnqueueTaskForIssueByActor(ctx, issue, q.CredentialOwnerID); err != nil {
		t.Fatal(err)
	}
	task, err := f.q.ClaimAgentTask(ctx, db.ClaimAgentTaskParams{AgentID: agent, RuntimeID: runtime, PrepareLeaseSecs: 45, RuntimeStaleSecs: 150, SupportsFixedInputManifests: true})
	if err != nil {
		t.Fatal(err)
	}
	version, err := f.q.GetCockpitInputManifestVersion(ctx, db.GetCockpitInputManifestVersionParams{WorkspaceID: q.WorkspaceID, IssueID: q.IssueID, ID: manifest})
	if err != nil {
		t.Fatal(err)
	}
	holder, err := f.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	var holderPID int32
	if err = holder.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&holderPID); err != nil {
		t.Fatal(err)
	}
	// Canonical enqueue already holds the first owner KEY SHARE before taking
	// the runtime KEY SHARE. The input authorization must coexist with it.
	if _, err = holder.Exec(ctx, "SELECT id FROM agent WHERE id=$1 FOR KEY SHARE", agent); err != nil {
		t.Fatal(err)
	}
	p := CockpitInputQuery{CockpitInputRead: CockpitInputRead{WorkspaceID: q.WorkspaceID, CredentialOwnerID: q.CredentialOwnerID, AgentID: agent, RunID: task.ID, RuntimeID: runtime, ClaimDispatchedAt: task.DispatchedAt, ActorSource: "daemon_claim"}, TaskID: task.ID}
	done := make(chan error, 1)
	go func() {
		_, e := s.RecordCockpitRunInputPreparation(ctx, p, CockpitRunInputPreparationInput{ManifestVersionID: util.UUIDToString(manifest), ManifestHash: version.ManifestHash, DispatchedAt: inputTime(task.DispatchedAt), State: "required_ready", PreparedInputVersionIDs: []string{}})
		done <- e
	}()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	completed := false
	var ackErr error
wait:
	for {
		select {
		case ackErr = <-done:
			completed = true
			break wait
		default:
		}
		var waiting bool
		if err = f.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)))", holderPID).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-ticker.C:
		}
	}
	var allowed bool
	fenceErr := holder.QueryRow(ctx, "SELECT lock_task_owner_rows($1,$2,$3)", agent, q.IssueID, runtime).Scan(&allowed)
	_ = holder.Rollback(context.Background())
	if !completed {
		select {
		case ackErr = <-done:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if fenceErr != nil || ackErr != nil || !allowed {
		t.Fatalf("canonical owner fence and input authorization deadlocked: fence=%v ack=%v allowed=%v", fenceErr, ackErr, allowed)
	}
}

func TestCockpitInputRunPreparationBroadcastsCommittedChangesAndRetainsPartialFailure(t *testing.T) {
	f, s, q := inputManifestFixture(t)
	ctx := context.Background()
	file := inputManifestReadyFile(t, s, q.CockpitInputRead, "prepared before index failure")
	saved, err := s.SaveCockpitInputManifest(ctx, q, CockpitInputManifestSaveInput{CommandKey: util.UUIDToString(dbid.NewV7()), Items: []CockpitInputManifestItemInput{{InputVersionID: util.UUIDToString(file.VersionID), Purpose: "material", Required: true}}})
	if err != nil {
		t.Fatal(err)
	}
	runtime, agent := inputManifestTaskAgent(t, f, q.CockpitInputRead, q.IssueID)
	tasks := NewTaskService(f.q, f.Pool, nil, s.Bus)
	issue, err := f.q.GetIssue(ctx, q.IssueID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tasks.EnqueueTaskForIssueByActor(ctx, issue, q.CredentialOwnerID); err != nil {
		t.Fatal(err)
	}
	task, err := f.q.ClaimAgentTask(ctx, db.ClaimAgentTaskParams{AgentID: agent, RuntimeID: runtime, PrepareLeaseSecs: 45, RuntimeStaleSecs: 150, SupportsFixedInputManifests: true})
	if err != nil {
		t.Fatal(err)
	}
	p := CockpitInputQuery{CockpitInputRead: CockpitInputRead{WorkspaceID: q.WorkspaceID, CredentialOwnerID: q.CredentialOwnerID, AgentID: agent, RunID: task.ID, RuntimeID: runtime, ClaimDispatchedAt: task.DispatchedAt, ActorSource: "daemon_claim"}, TaskID: task.ID}
	observed := []string{}
	s.Bus.Subscribe(protocol.EventCockpitChanged, func(event events.Event) {
		payload, ok := event.Payload.(map[string]any)
		if !ok || payload["scope"] != "input_manifests" {
			return
		}
		entity, ok := payload["entity"].(map[string]any)
		if !ok || entity["task_id"] != util.UUIDToString(task.ID) {
			return
		}
		if event.WorkspaceID != util.UUIDToString(q.WorkspaceID) || entity["issue_id"] != util.UUIDToString(q.IssueID) {
			t.Error("preparation event escaped exact scope")
		}
		committed, e := f.q.GetAgentTask(ctx, task.ID)
		if e != nil {
			t.Error(e)
			return
		}
		observed = append(observed, committed.InputPreparationState+":"+committed.InputPreparationErrorCode)
	})
	ack := CockpitRunInputPreparationInput{ManifestVersionID: saved.Receipt.ManifestVersionID, ManifestHash: saved.Receipt.ManifestHash, DispatchedAt: inputTime(task.DispatchedAt), State: "preparing", PreparedInputVersionIDs: []string{}}
	for range 2 {
		if _, err = s.RecordCockpitRunInputPreparation(ctx, p, ack); err != nil {
			t.Fatal(err)
		}
	}
	ack.State = "failed"
	ack.ErrorCode = "input_index_write_failed"
	ack.PreparedInputVersionIDs = []string{util.UUIDToString(file.VersionID)}
	for range 2 {
		if _, err = s.RecordCockpitRunInputPreparation(ctx, p, ack); err != nil {
			t.Fatalf("partially prepared bytes prevented reporting the actual preparation failure: %v", err)
		}
	}
	ack.State = "required_ready"
	ack.ErrorCode = ""
	for range 2 {
		if _, err = s.RecordCockpitRunInputPreparation(ctx, p, ack); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(observed, []string{"preparing:", "failed:input_index_write_failed", "required_ready:"}) {
		t.Fatalf("events were duplicated, omitted, or published before commit: %+v", observed)
	}
}
