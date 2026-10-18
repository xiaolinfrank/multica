package service

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestCockpitDirectoryAuthorizationCoexistsWithCanonicalOwnerFence(t *testing.T) {
	f, _, _, _ := legacyDirectoryFixture(t, true)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	credentialOwner := f.member(t, "directory-lock-runtime-owner")
	runtime := f.Runtime(t, "Directory authorization runtime", testutil.Cols{"owner_id": credentialOwner, "visibility": "public"})
	agent := f.Agent(t, "Directory authorization producer", runtime, testutil.Cols{"owner_id": f.owner, "permission_mode": "private", "status": "idle"})
	issue := f.Issue(t, "Directory preparation source")
	f.InsertNoID(t, "cockpit_meeting_issue", testutil.Cols{"workspace_id": f.ws, "meeting_id": f.meeting, "issue_id": issue, "role": "task", "roles": []string{"preparation"}}, "workspace_id=$1 AND meeting_id=$2 AND issue_id=$3", f.ws, f.meeting, issue)
	run := f.Task(t, agent, testutil.Cols{"issue_id": issue, "runtime_id": runtime, "status": "running", "originator_user_id": f.owner, "accountable_user_id": f.owner})
	token, err := f.q.CreateTaskToken(ctx, db.CreateTaskTokenParams{ID: dbid.NewV7(), TokenHash: util.UUIDToString(dbid.NewV7()), TaskID: parseTestUUID(t, run), AgentID: parseTestUUID(t, agent), WorkspaceID: f.ws, UserID: parseTestUUID(t, credentialOwner), ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	if err != nil {
		t.Fatal(err)
	}
	f.Cleanup(t, "DELETE FROM task_token WHERE id=$1", token.ID)
	p := CockpitDirectoryRead{WorkspaceID: f.ws, MeetingID: f.meeting, CredentialOwnerID: parseTestUUID(t, credentialOwner), ActorSource: "task_token", AgentID: parseTestUUID(t, agent), RunID: parseTestUUID(t, run), TaskTokenID: token.ID}
	holder, err := f.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	var pid int32
	if err = holder.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err = holder.Exec(ctx, "SELECT id FROM agent WHERE id=$1 FOR KEY SHARE", p.AgentID); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		tx, e := f.Pool.Begin(ctx)
		if e != nil {
			done <- e
			return
		}
		defer tx.Rollback(context.Background())
		_, e = directoryPrincipal(ctx, f.q.WithTx(tx), p, true)
		if e == nil {
			e = tx.Commit(ctx)
		}
		done <- e
	}()
	completed := false
	var authorizationErr error
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
wait:
	for {
		select {
		case authorizationErr = <-done:
			completed = true
			break wait
		default:
		}
		var waiting bool
		if err = f.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)))", pid).Scan(&waiting); err != nil {
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
	fenceErr := holder.QueryRow(ctx, "SELECT lock_task_owner_rows($1,$2,$3)", p.AgentID, parseTestUUID(t, issue), parseTestUUID(t, runtime)).Scan(&allowed)
	_ = holder.Rollback(context.Background())
	if !completed {
		select {
		case authorizationErr = <-done:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if fenceErr != nil || authorizationErr != nil || !allowed {
		t.Fatalf("directory authorization deadlocked canonical owner fence: fence=%v authorization=%v allowed=%v", fenceErr, authorizationErr, allowed)
	}
}
