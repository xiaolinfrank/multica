package handler

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
)

type issueHierarchyBarrier struct {
	base  txStarter
	count atomic.Int32
	ready chan struct{}
}

func (s *issueHierarchyBarrier) Begin(ctx context.Context) (pgx.Tx, error) {
	if s.count.Add(1) == 2 {
		close(s.ready)
	}
	select {
	case <-s.ready:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return s.base.Begin(ctx)
}
func TestIssueHierarchyDeepCycleIsRejected(t *testing.T) {
	f := newArtifactHTTPFixture(t)
	root := dbfx.Issue(t, "Hierarchy root", testutil.Cols{"workspace_id": f.ws, "project_id": f.project, "module_id": f.module})
	tip := root
	for i := 0; i < 18; i++ {
		tip = dbfx.Issue(t, fmt.Sprintf("Hierarchy depth %d", i+1), testutil.Cols{"workspace_id": f.ws, "parent_issue_id": tip, "project_id": f.project, "module_id": f.module})
	}
	response := f.call(t, f.h.UpdateIssue, http.MethodPut, "/issues", map[string]any{"parent_issue_id": tip, "suppress_run": true}, "id", root)
	if response.Code < 400 {
		t.Fatalf("a descendant deeper than the old 10-level check became its ancestor: %s", response.Body.String())
	}
	var parent *string
	dbfx.QueryRow(t, "SELECT parent_issue_id::text FROM issue WHERE id=$1", root).Scan(&parent)
	if parent != nil {
		t.Fatal("cycle was persisted")
	}
}
func TestIssueHierarchyConcurrentCrossParentCannotCommitCycle(t *testing.T) {
	f := newArtifactHTTPFixture(t)
	a := dbfx.Issue(t, "Concurrent A", testutil.Cols{"workspace_id": f.ws, "project_id": f.project, "module_id": f.module})
	b := dbfx.Issue(t, "Concurrent B", testutil.Cols{"workspace_id": f.ws, "project_id": f.project, "module_id": f.module})
	h := *f.h
	h.TxStarter = &issueHierarchyBarrier{base: testPool, ready: make(chan struct{})}
	statuses := make(chan int, 2)
	for _, pair := range [][2]string{{a, b}, {b, a}} {
		go func(pair [2]string) {
			original := cockpitRequest(http.MethodPut, "/issues", f.ws, map[string]any{"parent_issue_id": pair[1], "suppress_run": true})
			ctx, cancel := context.WithTimeout(original.Context(), 10*time.Second)
			defer cancel()
			req := testutil.WithURLParams(original.WithContext(ctx), "id", pair[0])
			recorder := httptest.NewRecorder()
			cockpitHandler(h.UpdateIssue).ServeHTTP(recorder, req)
			statuses <- recorder.Code
		}(pair)
	}
	first, second := <-statuses, <-statuses
	if (first == 200) == (second == 200) || first >= 500 || second >= 500 {
		t.Fatalf("cross-parent writes must serialize one success and one refusal, got %d/%d", first, second)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM issue a JOIN issue b ON b.id=a.parent_issue_id AND b.parent_issue_id=a.id WHERE a.workspace_id=$1", f.ws); n != 0 {
		t.Fatal("concurrent cycle remains")
	}
}

func TestIssueHierarchyDeepFilingMovesAtomicallyAndMoveSharesRules(t *testing.T) {
	f := newArtifactHTTPFixture(t)
	moduleB := dbfx.Module(t, f.project, "Deep destination", testutil.Cols{"workspace_id": f.ws})
	root := dbfx.Issue(t, "Deep filing root", testutil.Cols{"workspace_id": f.ws, "project_id": f.project, "module_id": f.module})
	ids := []string{root}
	tip := root
	for i := 0; i < 18; i++ {
		tip = dbfx.Issue(t, fmt.Sprintf("Deep filing child %d", i), testutil.Cols{"workspace_id": f.ws, "parent_issue_id": tip, "project_id": f.project, "module_id": f.module})
		ids = append(ids, tip)
	}
	assertAll := func(module string) {
		t.Helper()
		for _, id := range ids {
			var got string
			dbfx.QueryRow(t, "SELECT module_id::text FROM issue WHERE id=$1", id).Scan(&got)
			if got != module {
				t.Fatalf("descendant %s scope=%s want %s", id, got, module)
			}
		}
	}
	rejected := *f.h
	rejected.TxStarter = cockpitDeleteRejectCommit{base: testPool, err: pgx.ErrTxCommitRollback}
	f.call(t, rejected.UpdateIssue, http.MethodPut, "/issues", map[string]any{"module_id": moduleB, "suppress_run": true}, "id", root).Want(500)
	assertAll(f.module)
	f.call(t, f.h.MoveIssue, http.MethodPost, "/move", map[string]any{"module_id": moduleB, "before_id": nil, "after_id": nil}, "id", root).Want(200)
	assertAll(moduleB)
	f.call(t, f.h.BatchUpdateIssues, http.MethodPost, "/batch-update", map[string]any{"issue_ids": []string{root}, "updates": map[string]any{"module_id": f.module, "suppress_run": true}}).Want(200)
	assertAll(f.module)
}

func TestIssueHierarchyOrdinaryFieldDoesNotRestoreStaleFiling(t *testing.T) {
	for _, field := range []string{"title", "status"} {
		t.Run(field, func(t *testing.T) {
			f := newArtifactHTTPFixture(t)
			projectB := dbfx.Project(t, "Concurrent filing", testutil.Cols{"workspace_id": f.ws})
			moduleB := dbfx.Module(t, projectB, "Concurrent module", testutil.Cols{"workspace_id": f.ws})
			parentA := dbfx.Issue(t, "Initial parent", testutil.Cols{"workspace_id": f.ws, "project_id": f.project, "module_id": f.module})
			parentB := dbfx.Issue(t, "New parent", testutil.Cols{"workspace_id": f.ws, "project_id": projectB, "module_id": moduleB})
			child := dbfx.Issue(t, "Child", testutil.Cols{"workspace_id": f.ws, "project_id": f.project, "module_id": f.module, "parent_issue_id": parentA})
			h := *f.h
			h.TxStarter = &cockpitDeleteRaceTxStarter{base: testPool, before: func() error {
				response := f.call(t, f.h.UpdateIssue, http.MethodPut, "/issues", map[string]any{"parent_issue_id": parentB, "suppress_run": true}, "id", child)
				if response.Code != 200 {
					return fmt.Errorf("interleaved parent update returned %d: %s", response.Code, response.Body.String())
				}
				return nil
			}}
			value := "Edited title"
			if field == "status" {
				value = "in_progress"
			}
			f.call(t, h.UpdateIssue, http.MethodPut, "/issues", map[string]any{field: value, "suppress_run": true}, "id", child).Want(200)
			var parent, project, module string
			dbfx.QueryRow(t, "SELECT parent_issue_id::text,project_id::text,module_id::text FROM issue WHERE id=$1", child).Scan(&parent, &project, &module)
			if parent != parentB || project != projectB || module != moduleB {
				t.Fatal("ordinary field update restored pre-lock parent/project/module")
			}
		})
	}
}

func TestIssueHierarchyCreatePreservesExplicitProjectOverride(t *testing.T) {
	f := newArtifactHTTPFixture(t)
	parent := dbfx.Issue(t, "Parent directly in project", testutil.Cols{"workspace_id": f.ws, "project_id": f.project})
	other := dbfx.Project(t, "Other project", testutil.Cols{"workspace_id": f.ws})
	dbfx.Exec(t, "UPDATE workspace SET issue_counter=(SELECT MAX(number) FROM issue WHERE workspace_id=$1) WHERE id=$1", f.ws)
	f.call(t, f.h.CreateIssue, http.MethodPost, "/issues", map[string]any{"title": "Explicit legacy project choice", "status": "backlog", "parent_issue_id": parent, "project_id": other}).Want(201)
	if n := dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1 AND title='Explicit legacy project choice' AND parent_issue_id=$2 AND project_id=$3 AND module_id IS NULL", f.ws, parent, other); n != 1 {
		t.Fatal("explicit Create project override was replaced with SetParent inheritance semantics")
	}
}

type hierarchyPauseStarter struct {
	base                  txStarter
	parent                pgtype.UUID
	read, resume, locking chan struct{}
}

func (s hierarchyPauseStarter) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.base.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return hierarchyPauseTx{Tx: tx, control: s}, nil
}

type hierarchyPauseTx struct {
	pgx.Tx
	control hierarchyPauseStarter
}

func (tx hierarchyPauseTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	if tx.control.locking != nil && strings.Contains(sql, "-- name: LockIssueHierarchy ") {
		select {
		case <-tx.control.locking:
		default:
			close(tx.control.locking)
		}
	}
	return tx.Tx.Exec(ctx, sql, args...)
}
func (tx hierarchyPauseTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	row := tx.Tx.QueryRow(ctx, sql, args...)
	if tx.control.read != nil && strings.Contains(sql, "-- name: GetIssueInWorkspace ") && len(args) > 0 && args[0] == tx.control.parent {
		return hierarchyPauseRow{row: row, ctx: ctx, read: tx.control.read, resume: tx.control.resume}
	}
	return row
}

type hierarchyPauseRow struct {
	row          pgx.Row
	ctx          context.Context
	read, resume chan struct{}
}

func (r hierarchyPauseRow) Scan(dest ...any) error {
	if err := r.row.Scan(dest...); err != nil {
		return err
	}
	select {
	case <-r.read:
	default:
		close(r.read)
	}
	select {
	case <-r.resume:
		return nil
	case <-r.ctx.Done():
		return r.ctx.Err()
	}
}

func TestIssueHierarchyCreateAndParentMoveSerializeInheritance(t *testing.T) {
	f := newArtifactHTTPFixture(t)
	parent := dbfx.Issue(t, "Move after child snapshot", testutil.Cols{"workspace_id": f.ws, "project_id": f.project, "module_id": f.module})
	destination := dbfx.Module(t, f.project, "New filing", testutil.Cols{"workspace_id": f.ws})
	dbfx.Exec(t, "UPDATE workspace SET issue_counter=(SELECT MAX(number) FROM issue WHERE workspace_id=$1) WHERE id=$1", f.ws)
	read, resume, locking := make(chan struct{}), make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-resume:
		default:
			close(resume)
		}
	}()
	createHandler := *f.h
	creator := *f.h.IssueService
	creator.TxStarter = hierarchyPauseStarter{base: testPool, parent: parseUUID(parent), read: read, resume: resume}
	createHandler.IssueService = &creator
	moveHandler := *f.h
	moveHandler.TxStarter = hierarchyPauseStarter{base: testPool, locking: locking}
	createReply, moveReply := make(chan *httptest.ResponseRecorder, 1), make(chan *httptest.ResponseRecorder, 1)
	run := func(fn http.HandlerFunc, body map[string]any, param string, out chan *httptest.ResponseRecorder) {
		req := cockpitRequest(http.MethodPost, "/issues", f.ws, body)
		ctx, cancel := context.WithTimeout(req.Context(), 10*time.Second)
		defer cancel()
		req = req.WithContext(ctx)
		if param != "" {
			req = testutil.WithURLParams(req, "id", param)
		}
		rec := httptest.NewRecorder()
		cockpitHandler(fn).ServeHTTP(rec, req)
		out <- rec
	}
	go run(createHandler.CreateIssue, map[string]any{"title": "Child during parent migration", "parent_issue_id": parent, "status": "backlog"}, "", createReply)
	select {
	case <-read:
	case <-time.After(5 * time.Second):
		t.Fatal("create did not reach its parent snapshot")
	}
	go run(moveHandler.UpdateIssue, map[string]any{"module_id": destination, "suppress_run": true}, parent, moveReply)
	select {
	case <-locking:
	case <-time.After(5 * time.Second):
		t.Fatal("parent mutation did not reach hierarchy lock")
	}
	select {
	case result := <-moveReply:
		t.Fatalf("parent moved before child commit: %d %s", result.Code, result.Body.String())
	case <-time.After(50 * time.Millisecond):
	}
	close(resume)
	created, moved := <-createReply, <-moveReply
	if created.Code != 201 || moved.Code != 200 {
		t.Fatalf("create/move=%d/%d: %s %s", created.Code, moved.Code, created.Body.String(), moved.Body.String())
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1 AND (id=$2 OR title='Child during parent migration') AND module_id=$3", f.ws, parent, destination); n != 2 {
		t.Fatal("child inherited a scope outside the final parent transaction")
	}
}
