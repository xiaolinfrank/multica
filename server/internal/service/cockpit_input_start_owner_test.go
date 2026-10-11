package service

import (
	"context"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestCockpitInputStartRetainsCredentialOwnerAcrossRuntimeChanges(t *testing.T) {
	for _, duringWait := range []bool{false, true} {
		name := "changed before transaction"
		if duringWait {
			name = "changed while waiting for runtime authority"
		}
		t.Run(name, func(t *testing.T) {
			f, s, q := inputManifestFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			manifest := inputManifestSaveEmpty(t, s, q, 0)
			runtime, agent := inputManifestTaskAgent(t, f, q.CockpitInputRead, q.IssueID)
			other := parseTestUUID(t, f.member(t, "new-runtime-credential-owner"))
			// Public runtimes keep the original Agent/originator relationship valid;
			// the rejected fact must be the captured caller's credential ownership.
			if _, err := f.Pool.Exec(ctx, "UPDATE agent_runtime SET visibility='public' WHERE id=$1", runtime); err != nil {
				t.Fatal(err)
			}
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
			p := CockpitInputQuery{CockpitInputRead: CockpitInputRead{WorkspaceID: q.WorkspaceID, CredentialOwnerID: q.CredentialOwnerID, AgentID: agent, RunID: task.ID, RuntimeID: runtime, ClaimDispatchedAt: task.DispatchedAt, ActorSource: "daemon_claim"}, TaskID: task.ID}
			_, err = s.RecordCockpitRunInputPreparation(ctx, p, CockpitRunInputPreparationInput{ManifestVersionID: util.UUIDToString(manifest), ManifestHash: version.ManifestHash, DispatchedAt: inputTime(task.DispatchedAt), State: "required_ready", PreparedInputVersionIDs: []string{}})
			if err != nil {
				t.Fatal(err)
			}
			captured := WithInputClaimCredentialOwner(ctx, q.CredentialOwnerID)
			start := func() error {
				_, e := tasks.StartTaskForClaim(captured, db.LockAgentTaskStartClaimParams{ID: task.ID, RuntimeID: runtime, DispatchedAt: task.DispatchedAt})
				return e
			}
			if !duringWait {
				if _, err = f.Pool.Exec(ctx, "UPDATE agent_runtime SET owner_id=$2 WHERE id=$1", runtime, other); err != nil {
					t.Fatal(err)
				}
				err = start()
			} else {
				holder, e := f.Pool.Begin(ctx)
				if e != nil {
					t.Fatal(e)
				}
				defer holder.Rollback(context.Background())
				var holderPID int32
				if e = holder.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&holderPID); e != nil {
					t.Fatal(e)
				}
				if _, e = holder.Exec(ctx, "UPDATE agent_runtime SET owner_id=$2 WHERE id=$1", runtime, other); e != nil {
					t.Fatal(e)
				}
				done := make(chan error, 1)
				go func() { done <- start() }()
				ticker := time.NewTicker(5 * time.Millisecond)
				defer ticker.Stop()
				for {
					var waiting bool
					if e = f.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)))", holderPID).Scan(&waiting); e != nil {
						t.Fatal(e)
					}
					if waiting {
						break
					}
					select {
					case e = <-done:
						t.Fatalf("Start bypassed runtime authority lock: %v", e)
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					case <-ticker.C:
					}
				}
				if e = holder.Commit(ctx); e != nil {
					t.Fatal(e)
				}
				err = <-done
			}
			if inputErrorCode(err) != "permission_revoked" {
				t.Fatalf("Start did not retain the authenticated owner: %v", err)
			}
			current, err := f.q.GetAgentTask(ctx, task.ID)
			if err != nil || current.Status != "dispatched" || current.StartedAt.Valid || current.InputPreparationState != "required_ready" {
				t.Fatalf("rejected caller mutated the prepared claim: %+v %v", current, err)
			}
		})
	}
}
