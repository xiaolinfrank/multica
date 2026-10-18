package handler

import (
	"errors"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

type testIssueBatchReply struct {
	service.IssueBatchReceipt
	Updated int    `json:"updated"`
	Deleted int    `json:"deleted"`
	Code    string `json:"code"`
}

func TestIssueBatchReceiptPreservesPartialConflict(t *testing.T) {
	f := newArtifactHTTPFixture(t)
	artifact := f.create(t)
	v := f.submit(t, artifact)
	a := dbfx.Issue(t, "Applied first", testutil.Cols{"workspace_id": f.ws, "status": "todo"})
	c := dbfx.Issue(t, "Untouched last", testutil.Cols{"workspace_id": f.ws, "status": "todo"})
	ids := []string{a, v.Version.Version.ReviewIssue.ID, c}
	var reply testIssueBatchReply
	f.call(t, f.h.BatchUpdateIssues, http.MethodPost, "/batch-update", map[string]any{"issue_ids": ids, "updates": map[string]any{"status": "done", "suppress_run": true}}).Want(409).JSON(&reply)
	if reply.Updated != 1 || reply.TransactionMode != "per_item" || reply.TransactionOutcome != "partial" || len(reply.Results) != 3 || len(reply.UnconfirmedIDs) != 0 {
		t.Fatalf("false all-success or missing receipt: %+v", reply)
	}
	for i, outcome := range []string{"applied", "rejected", "not_attempted"} {
		if reply.Results[i].IssueID != ids[i] || reply.Results[i].Outcome != outcome {
			t.Fatalf("wrong item %d: %+v", i, reply)
		}
	}
	if reply.Results[1].Code != "formal_review_required" {
		t.Fatalf("lost domain conflict: %+v", reply)
	}
	for i, id := range ids {
		var status string
		dbfx.QueryRow(t, "SELECT status FROM issue WHERE id=$1", id).Scan(&status)
		want := "todo"
		if i == 0 {
			want = "done"
		}
		if status != want {
			t.Fatalf("%d persisted %s, want %s", i, status, want)
		}
	}
}
func TestIssueBatchReceiptExpectedRevisionAndAtomicDelete(t *testing.T) {
	f := newArtifactHTTPFixture(t)
	artifact := f.create(t)
	v := f.submit(t, artifact)
	a := dbfx.Issue(t, "Retain until all checks pass", testutil.Cols{"workspace_id": f.ws, "status": "todo"})
	var revision int64
	dbfx.QueryRow(t, "SELECT revision FROM issue WHERE id=$1", a).Scan(&revision)
	var reply testIssueBatchReply
	f.call(t, f.h.BatchUpdateIssues, http.MethodPost, "/batch-update", map[string]any{"issue_ids": []string{a}, "updates": map[string]any{"priority": "high"}, "expected_revisions": map[string]int64{a: revision + 1}}).Want(409).JSON(&reply)
	if reply.Results[0].Outcome != "rejected" || reply.Results[0].Code != "revision_conflict" || reply.Updated != 0 {
		t.Fatalf("stale update pretended applied: %+v", reply)
	}
	f.call(t, f.h.BatchDeleteIssues, http.MethodPost, "/batch-delete", map[string]any{"issue_ids": []string{a, v.Version.Version.ReviewIssue.ID}}).Want(409).JSON(&reply)
	if reply.Deleted != 0 || reply.TransactionMode != "atomic" || reply.TransactionOutcome != "not_started" || reply.Results[0].Outcome != "not_attempted" || reply.Results[1].Outcome != "rejected" {
		t.Fatalf("atomic preflight reported a partial deletion: %+v", reply)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM issue WHERE id=$1", a); n != 1 {
		t.Fatal("ordinary issue deleted before protected-peer check")
	}
	f.call(t, f.h.BatchDeleteIssues, http.MethodPost, "/batch-delete", map[string]any{"issue_ids": []string{a}, "expected_revisions": map[string]int64{a: revision + 1}}).Want(409).JSON(&reply)
	if reply.Results[0].Code != "revision_conflict" {
		t.Fatalf("delete omitted locked revision: %+v", reply)
	}
	f.call(t, f.h.BatchDeleteIssues, http.MethodPost, "/batch-delete", map[string]any{"issue_ids": []string{a}, "expected_revisions": map[string]int64{a: revision}}).Want(200).JSON(&reply)
	if reply.Deleted != 1 || reply.Results[0].Outcome != "applied" || reply.TransactionOutcome != "committed" {
		t.Fatalf("committed deletion not confirmed: %+v", reply)
	}
}
func TestIssueBatchReceiptDistinguishesRollbackAndUnknownCommit(t *testing.T) {
	for _, tc := range []struct {
		name    string
		err     error
		outcome string
	}{{"confirmed rollback", pgx.ErrTxCommitRollback, "rolled_back"}, {"lost acknowledgement", errors.New("injected lost commit reply"), "unknown"}} {
		t.Run(tc.name, func(t *testing.T) {
			ws := cockpitMeetingFixture(t, "Batch receipt transaction outcome")
			a := dbfx.Issue(t, "First", testutil.Cols{"workspace_id": ws})
			b := dbfx.Issue(t, "Second", testutil.Cols{"workspace_id": ws})
			h := *testHandler
			h.TxStarter = cockpitDeleteRejectCommit{base: testPool, err: tc.err}
			var reply testIssueBatchReply
			testutil.Call(t, h.BatchDeleteIssues, cockpitRequest(http.MethodPost, "/batch-delete", ws, map[string]any{"issue_ids": []string{a, b}})).Want(500).JSON(&reply)
			if reply.Deleted != 0 || reply.TransactionOutcome != tc.outcome {
				t.Fatalf("wrong durable outcome: %+v", reply)
			}
			if tc.outcome == "rolled_back" {
				if len(reply.UnconfirmedIDs) != 0 || len(reply.Results) != 2 {
					t.Fatal(reply)
				}
				for _, r := range reply.Results {
					if r.Outcome != "not_applied" || r.Code != "batch_rolled_back" {
						t.Fatalf("attempted rollback called unattempted: %+v", r)
					}
				}
			} else if len(reply.UnconfirmedIDs) != 2 || len(reply.Results) != 0 {
				t.Fatalf("unknown commit claimed a result: %+v", reply)
			}
			if n := dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1 AND id IN ($2,$3)", ws, a, b); n != 2 {
				t.Fatal("fault fixture rollback did not retain rows")
			}
		})
	}
}
func TestIssueBatchReceiptRevisionGuardSurvivesConcurrentRead(t *testing.T) {
	ws := cockpitMeetingFixture(t, "Batch locked revision")
	id := dbfx.Issue(t, "Before locked mutation", testutil.Cols{"workspace_id": ws})
	var revision int64
	dbfx.QueryRow(t, "SELECT revision FROM issue WHERE id=$1", id).Scan(&revision)
	h := *testHandler
	hook := &cockpitDeleteRaceTxStarter{base: testPool}
	// This hook executes after the handler's read and before its write transaction.
	hook.before = func() error {
		dbfx.Exec(t, "UPDATE issue SET title='Concurrent editor', revision=revision+1 WHERE id=$1", id)
		return nil
	}
	h.TxStarter = hook
	var out testIssueBatchReply
	testutil.Call(t, h.BatchUpdateIssues, cockpitRequest(http.MethodPost, "/batch-update", ws, map[string]any{"issue_ids": []string{id}, "updates": map[string]any{"title": "Stale overwrite"}, "expected_revisions": map[string]int64{id: revision}})).Want(409).JSON(&out)
	var title string
	dbfx.QueryRow(t, "SELECT title FROM issue WHERE id=$1", id).Scan(&title)
	if title != "Concurrent editor" || len(out.Results) != 1 || out.Results[0].Code != "revision_conflict" {
		t.Fatalf("pre-read check replaced transactional CAS: %s %+v", title, out)
	}
}
