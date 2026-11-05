package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
	reviewID := v.Version.Version.ReviewIssue.ID
	// The delete transaction orders UUIDs. This ordinary task must be deleted
	// before the formal-review guard fails, so persistence proves rollback.
	a := dbfx.Issue(t, "Retain until all checks pass", testutil.Cols{"id": "00000000-0000-4000-8000-000000000001", "workspace_id": f.ws, "status": "todo"})
	if a >= reviewID {
		t.Fatal("fixture did not order the ordinary deletion before the review")
	}
	b := dbfx.Issue(t, "Second ordinary batch member", testutil.Cols{"workspace_id": f.ws, "status": "todo"})
	child := dbfx.Issue(t, "Retain parent relation", testutil.Cols{"workspace_id": f.ws, "parent_issue_id": a})
	attachment := dbfx.Insert(t, "attachment", testutil.Cols{
		"workspace_id": f.ws, "issue_id": a,
		"uploader_type": "member", "uploader_id": testUserID,
		"filename": "retained.txt", "url": "https://example.test/retained.txt",
		"content_type": "text/plain", "size_bytes": 1,
	})
	retainedRows := []struct {
		query  string
		id     string
		before string
	}{
		{"SELECT row_to_json(i)::text FROM issue i WHERE id=$1", a, ""},
		{"SELECT row_to_json(i)::text FROM issue i WHERE id=$1", b, ""},
		{"SELECT row_to_json(i)::text FROM issue i WHERE id=$1", reviewID, ""},
		{"SELECT row_to_json(i)::text FROM issue i WHERE id=$1", child, ""},
		{"SELECT row_to_json(a)::text FROM attachment a WHERE id=$1", attachment, ""},
		{"SELECT row_to_json(p)::text FROM cockpit_issue_primary p WHERE issue_id=$1", reviewID, ""},
		{"SELECT row_to_json(v)::text FROM cockpit_artifact_version v WHERE id=$1", v.Version.Version.ID, ""},
	}
	for i := range retainedRows {
		row := &retainedRows[i]
		dbfx.QueryRow(t, row.query, row.id).Scan(&row.before)
	}
	var revision int64
	dbfx.QueryRow(t, "SELECT revision FROM issue WHERE id=$1", a).Scan(&revision)
	var reply testIssueBatchReply
	f.call(t, f.h.BatchUpdateIssues, http.MethodPost, "/batch-update", map[string]any{"issue_ids": []string{a}, "updates": map[string]any{"priority": "high"}, "expected_revisions": map[string]int64{a: revision + 1}}).Want(409).JSON(&reply)
	if reply.Results[0].Outcome != "rejected" || reply.Results[0].Code != "revision_conflict" || reply.Updated != 0 {
		t.Fatalf("stale update pretended applied: %+v", reply)
	}
	ids := []string{a, reviewID, b}
	f.call(t, f.h.BatchDeleteIssues, http.MethodPost, "/batch-delete", map[string]any{"issue_ids": ids}).Want(409).JSON(&reply)
	if reply.Code != "formal_review_required" || reply.Deleted != 0 || reply.TransactionMode != "atomic" || reply.TransactionOutcome != "rolled_back" || len(reply.Results) != len(ids) || len(reply.UnconfirmedIDs) != 0 {
		t.Fatalf("atomic rollback lost its domain conflict or durable outcome: %+v", reply)
	}
	for i, id := range ids {
		if reply.Results[i].IssueID != id || reply.Results[i].Outcome != "not_applied" || reply.Results[i].Code != "batch_rolled_back" {
			t.Fatalf("rolled-back member reported applied or unattempted: %+v", reply.Results[i])
		}
	}
	for _, row := range retainedRows {
		var after string
		dbfx.QueryRow(t, row.query, row.id).Scan(&after)
		if after != row.before {
			t.Fatalf("rejected atomic deletion changed retained row %s", row.id)
		}
	}
	f.call(t, f.h.BatchDeleteIssues, http.MethodPost, "/batch-delete", map[string]any{"issue_ids": []string{a}, "expected_revisions": map[string]int64{a: revision + 1}}).Want(409).JSON(&reply)
	if reply.Results[0].Code != "revision_conflict" {
		t.Fatalf("delete omitted locked revision: %+v", reply)
	}
	f.call(t, f.h.BatchDeleteIssues, http.MethodPost, "/batch-delete", map[string]any{"issue_ids": []string{a, b}, "expected_revisions": map[string]int64{a: revision}}).Want(200).JSON(&reply)
	if reply.Deleted != 2 || len(reply.Results) != 2 || reply.Results[0].Outcome != "applied" || reply.Results[1].Outcome != "applied" || reply.TransactionOutcome != "committed" {
		t.Fatalf("committed deletion not confirmed: %+v", reply)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM issue WHERE id IN ($1,$2)", a, b); n != 0 {
		t.Fatal("successful ordinary batch retained deleted issues")
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM issue WHERE id=$1 AND parent_issue_id IS NULL", child); n != 1 {
		t.Fatal("successful ordinary batch did not detach the retained child")
	}
}

func TestIssueDeleteConflictOnlyMapsRetainedArtifactConstraint(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		code string
	}{
		{"formal review retention", fmt.Errorf("tombstone cockpit primary ownership: %w", &pgconn.PgError{Code: "23514", ConstraintName: "cockpit_artifact_integrity"}), "formal_review_required"},
		{"other check constraint", &pgconn.PgError{Code: "23514", ConstraintName: "other_constraint"}, ""},
		{"other SQL state", &pgconn.PgError{Code: "23505", ConstraintName: "cockpit_artifact_integrity"}, ""},
		{"ordinary failure", errors.New("write failed"), ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			handled := writeIssueDeleteConflict(w, tc.err)
			if tc.code == "" {
				if handled || w.Body.Len() != 0 {
					t.Fatal("unrelated failure disguised as a domain conflict")
				}
				return
			}
			var reply struct {
				Code string `json:"code"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &reply); err != nil {
				t.Fatal(err)
			}
			if !handled || w.Code != http.StatusConflict || reply.Code != tc.code {
				t.Fatalf("protected review not mapped to conflict: status=%d reply=%+v", w.Code, reply)
			}
		})
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
