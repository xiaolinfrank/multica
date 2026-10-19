package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func singleOwnerDeleteWorkspace(t *testing.T) (string, *testutil.Fixture) {
	t.Helper()
	wsID := dbfx.Workspace(t, "Single owner delete guard", "owner-guard-"+uuid.NewString())
	dbfx.Member(t, wsID, testUserID, "owner")
	return wsID, testutil.New(testPool, wsID, testUserID)
}

func singleOwnerBinding(t *testing.T, workspaceID string) {
	t.Helper()
	dbfx.InsertNoID(t, "single_owner_account", testutil.Cols{
		"singleton": 1, "user_id": testUserID, "workspace_id": workspaceID,
		"login_name": "owner", "password_hash": "test-password-hash",
		"recovery_hash": "test-recovery-hash", "credential_version": "test-version",
	}, "singleton = 1")
}

func singleOwnerDeleteRequest(workspaceID string) *http.Request {
	r := newRequest(http.MethodDelete, "/api/workspaces/"+workspaceID, nil)
	return withURLParam(r, "id", workspaceID)
}

func TestDeleteWorkspace_ProtectsSingleOwnerBindingWithoutModeSwitch(t *testing.T) {
	for _, mode := range []string{"true", "false", ""} {
		t.Run("mode="+mode, func(t *testing.T) {
			t.Setenv("MULTICA_SINGLE_OWNER", mode)
			wsID, fixture := singleOwnerDeleteWorkspace(t)
			singleOwnerBinding(t, wsID)
			projectID := fixture.Project(t, "Preserved project")
			issueID := fixture.Issue(t, "Preserved issue", testutil.Cols{"project_id": projectID})
			runtimeID := fixture.Runtime(t, "Preserved runtime")
			agentID := fixture.Agent(t, "Preserved agent", runtimeID)
			fixture.Task(t, agentID, testutil.Cols{"issue_id": issueID, "runtime_id": runtimeID})
			// Compare whole rows, including credentials and business progress, rather
			// than only proving that some replacement rows still exist.
			queries := []string{
				`SELECT row_to_json(x)::text FROM single_owner_account x WHERE workspace_id = $1`,
				`SELECT row_to_json(x)::text FROM "user" x WHERE id = (SELECT user_id FROM single_owner_account WHERE workspace_id = $1)`,
				`SELECT row_to_json(x)::text FROM workspace x WHERE id = $1`,
				`SELECT row_to_json(x)::text FROM member x WHERE workspace_id = $1`,
				`SELECT row_to_json(x)::text FROM project x WHERE workspace_id = $1`,
				`SELECT row_to_json(x)::text FROM issue x WHERE workspace_id = $1`,
				`SELECT row_to_json(x)::text FROM agent_task_queue x JOIN agent a ON a.id=x.agent_id WHERE a.workspace_id = $1`,
			}
			before := make([]string, len(queries))
			for i, query := range queries {
				fixture.QueryRow(t, query, wsID).Scan(&before[i])
			}
			var out struct {
				Code string `json:"code"`
			}
			testutil.Call(t, testHandler.DeleteWorkspace, singleOwnerDeleteRequest(wsID)).Want(http.StatusConflict).JSON(&out)
			if out.Code != "single_owner_workspace_protected" {
				t.Fatalf("unexpected error code: %q", out.Code)
			}
			for i, query := range queries {
				var after string
				fixture.QueryRow(t, query, wsID).Scan(&after)
				if after != before[i] {
					t.Errorf("protected deletion changed row %d", i)
				}
			}
		})
	}
}

func TestDeleteWorkspace_AllowsUnboundWorkspaceWithSingleOwnerAccount(t *testing.T) {
	t.Setenv("MULTICA_SINGLE_OWNER", "true")
	singleOwnerBinding(t, testWorkspaceID)
	wsID, _ := singleOwnerDeleteWorkspace(t)
	testutil.Call(t, testHandler.DeleteWorkspace, singleOwnerDeleteRequest(wsID)).Want(http.StatusNoContent)
	if got := dbfx.Count(t, `SELECT count(*) FROM workspace WHERE id = $1`, wsID); got != 0 {
		t.Fatal("unbound workspace was not deleted")
	}
	if got := dbfx.Count(t, `SELECT count(*) FROM single_owner_account a JOIN workspace w ON w.id=a.workspace_id WHERE a.workspace_id = $1`, testWorkspaceID); got != 1 {
		t.Fatal("unrelated single owner binding changed")
	}
}

func TestDeleteWorkspace_SingleOwnerLookupFailurePreservesWorkspace(t *testing.T) {
	// Use an isolated schema to simulate a missing account table without
	// altering the suite's migrated schema or any other test's binding.
	h, fixture := freshLocalDashboardHandler(t)
	ownerID := fixture.User(t, "Owner", "guard@example.invalid")
	wsID := fixture.Workspace(t, "Protected on lookup failure", "guard-failure")
	fixture.Member(t, wsID, ownerID, "owner")
	fixture.Exec(t, `DROP TABLE single_owner_account`)
	req := singleOwnerDeleteRequest(wsID)
	req.Header.Set("X-User-ID", ownerID)
	testutil.Call(t, h.DeleteWorkspace, req).Want(http.StatusInternalServerError)
	if got := fixture.Count(t, `SELECT count(*) FROM workspace WHERE id=$1`, wsID); got != 1 {
		t.Fatal("workspace changed when the binding check failed")
	}
	if got := fixture.Count(t, `SELECT count(*) FROM member WHERE workspace_id=$1 AND user_id=$2`, wsID, ownerID); got != 1 {
		t.Fatal("membership changed when the binding check failed")
	}
}

func TestDeleteWorkspace_SingleOwnerLookupTimeoutPreservesWorkspace(t *testing.T) {
	wsID, fixture := singleOwnerDeleteWorkspace(t)
	setWorkspaceDeleteLockTimeoutForTest(t, 100*time.Millisecond)
	holder, err := testPool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	if _, err := holder.Exec(t.Context(), `LOCK TABLE single_owner_account IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	testutil.Call(t, testHandler.DeleteWorkspace, singleOwnerDeleteRequest(wsID)).Want(http.StatusServiceUnavailable)
	if got := fixture.Count(t, `SELECT count(*) FROM workspace WHERE id=$1`, wsID); got != 1 {
		t.Fatal("workspace changed when the binding lookup timed out")
	}
	if got := fixture.Count(t, `SELECT count(*) FROM member WHERE workspace_id=$1`, wsID); got != 1 {
		t.Fatal("membership changed when the binding lookup timed out")
	}
}

// The gates pause real database transactions immediately before commit. No
// handler SQL is mocked: the competing handler must wait on PostgreSQL's
// advisory lock before it can observe the first transaction's outcome.
type singleOwnerTxGate struct {
	txStarter
	started chan uint32
	ready   chan struct{}
	release chan struct{}
}

func (g singleOwnerTxGate) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := g.txStarter.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if g.started != nil {
		g.started <- tx.Conn().PgConn().PID()
	}
	return singleOwnerGatedTx{Tx: tx, ready: g.ready, release: g.release}, nil
}

type singleOwnerGatedTx struct {
	pgx.Tx
	ready   chan struct{}
	release chan struct{}
}

func (tx singleOwnerGatedTx) Commit(ctx context.Context) error {
	if tx.ready != nil {
		close(tx.ready)
		select {
		case <-tx.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return tx.Tx.Commit(ctx)
}

func waitSingleOwnerSignal[T any](t *testing.T, c <-chan T, label string) T {
	t.Helper()
	select {
	case result := <-c:
		return result
	case <-time.After(10 * time.Second):
		t.Fatalf("timed out waiting for %s", label)
		var zero T
		return zero
	}
}

func waitSingleOwnerAdvisoryLock(t *testing.T, pid uint32) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var waiting bool
		dbfx.QueryRow(t, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND wait_event='advisory' AND query LIKE '%70344792103%')`, pid).Scan(&waiting)
		if waiting {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("transaction %d did not wait on the single owner advisory lock", pid)
}

func TestDeleteWorkspace_SerializesWithSingleOwnerAdoption(t *testing.T) {
	for _, first := range []string{"adopt", "delete"} {
		t.Run(first+"_first", func(t *testing.T) {
			wsID, _ := singleOwnerDeleteWorkspace(t)
			t.Setenv("MULTICA_SINGLE_OWNER", "true")
			t.Setenv("MULTICA_ADOPT_OWNER_ID", testUserID)
			t.Setenv("MULTICA_ADOPT_WORKSPACE_ID", wsID)
			setupToken := strings.Repeat("a", 64)
			setupPath := filepath.Join(t.TempDir(), "setup-token")
			if err := os.WriteFile(setupPath, []byte(setupToken), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("MULTICA_SETUP_TOKEN_FILE", setupPath)
			dbfx.Cleanup(t, `DELETE FROM single_owner_account WHERE workspace_id=$1`, wsID)
			setupHandler, deleteHandler := *testHandler, *testHandler
			setupHandler.cfg.AppURL = "http://127.0.0.1:23127"
			setupReq := testutil.JSONRequest(http.MethodPost, setupHandler.cfg.AppURL+"/auth/local/setup", map[string]string{
				"login_name": "owner", "display_name": "Owner", "password": "test-owner-password-2026",
			})
			setupReq.RemoteAddr = "127.0.0.1:1234"
			setupReq.Header.Set("Origin", setupHandler.cfg.AppURL)
			setupReq.Header.Set("X-Setup-Token", setupToken)
			deleteReq := singleOwnerDeleteRequest(wsID)
			ctx, cancel := context.WithTimeout(deleteReq.Context(), 20*time.Second)
			defer cancel()
			setupReq, deleteReq = setupReq.WithContext(ctx), deleteReq.WithContext(ctx)
			ready, release := make(chan struct{}), make(chan struct{})
			var releaseOnce sync.Once
			releaseFirst := func() { releaseOnce.Do(func() { close(release) }) }
			var workers sync.WaitGroup
			defer func() { releaseFirst(); cancel(); workers.Wait() }()
			started := make(chan uint32, 1)
			firstGate := singleOwnerTxGate{txStarter: testPool, ready: ready, release: release}
			secondGate := singleOwnerTxGate{txStarter: testPool, started: started}
			if first == "adopt" {
				setupHandler.TxStarter, deleteHandler.TxStarter = firstGate, secondGate
			} else {
				deleteHandler.TxStarter, setupHandler.TxStarter = firstGate, secondGate
			}
			setupOut, deleteOut := httptest.NewRecorder(), httptest.NewRecorder()
			setupDone, deleteDone := make(chan struct{}), make(chan struct{})
			runSetup := func() { defer workers.Done(); setupHandler.SetupLocalAccount(setupOut, setupReq); close(setupDone) }
			runDelete := func() { defer workers.Done(); deleteHandler.DeleteWorkspace(deleteOut, deleteReq); close(deleteDone) }
			workers.Add(1)
			if first == "adopt" {
				go runSetup()
			} else {
				go runDelete()
			}
			waitSingleOwnerSignal(t, ready, first+" commit gate")
			workers.Add(1)
			if first == "adopt" {
				go runDelete()
			} else {
				go runSetup()
			}
			pid := waitSingleOwnerSignal(t, started, "second transaction")
			waitSingleOwnerAdvisoryLock(t, pid)
			releaseFirst()
			waitSingleOwnerSignal(t, setupDone, "setup response")
			waitSingleOwnerSignal(t, deleteDone, "delete response")
			if first == "adopt" {
				if setupOut.Code != http.StatusOK || deleteOut.Code != http.StatusConflict {
					t.Fatalf("adoption first: setup=%d delete=%d: %s / %s", setupOut.Code, deleteOut.Code, setupOut.Body, deleteOut.Body)
				}
				if got := dbfx.Count(t, `SELECT count(*) FROM single_owner_account a JOIN workspace w ON w.id=a.workspace_id JOIN member m ON m.workspace_id=w.id AND m.user_id=a.user_id WHERE a.workspace_id=$1`, wsID); got != 1 {
					t.Fatal("completed adoption lost its workspace or owner membership")
				}
			} else {
				if deleteOut.Code != http.StatusNoContent || setupOut.Code != http.StatusInternalServerError {
					t.Fatalf("deletion first: setup=%d delete=%d: %s / %s", setupOut.Code, deleteOut.Code, setupOut.Body, deleteOut.Body)
				}
				if got := dbfx.Count(t, `SELECT count(*) FROM single_owner_account WHERE workspace_id=$1`, wsID); got != 0 {
					t.Fatal("adoption bound the deleted workspace")
				}
			}
			if got := dbfx.Count(t, `SELECT count(*) FROM single_owner_account a LEFT JOIN workspace w ON w.id=a.workspace_id WHERE w.id IS NULL`); got != 0 {
				t.Fatalf("race left %d dangling single owner bindings", got)
			}
		})
	}
}
