package handler

import (
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// Pending-change queue tests. The ingest judgement matrix lives here once:
// every outcome a proposal can have is asserted in this file's matrix test,
// and the decision tests below it cover the state machine, not the judging.

// ingestChanges posts a batch and returns the per-proposal outcomes.
func ingestChanges(t *testing.T, wsID string, changes []map[string]any) CockpitIngestResponse {
	t.Helper()
	var out CockpitIngestResponse
	testutil.Call(t, cockpitHandler(testHandler.IngestCockpitChanges),
		cockpitRequest(http.MethodPost, "/api/cockpit/changes/ingest", wsID,
			map[string]any{"changes": changes})).
		Want(http.StatusOK).
		JSON(&out)
	return out
}

func listChanges(t *testing.T, wsID string) []CockpitPendingChangeResponse {
	t.Helper()
	var out []CockpitPendingChangeResponse
	testutil.Call(t, cockpitHandler(testHandler.ListCockpitChanges),
		cockpitRequest(http.MethodGet, "/api/cockpit/changes", wsID, nil)).
		Want(http.StatusOK).
		JSON(&out)
	return out
}

// changeID returns the id of the one OPEN change the queue holds, failing the
// test otherwise. Decided rows stay in the list as history; they are not the
// queue's work any more.
func changeID(t *testing.T, wsID string) string {
	t.Helper()
	var open []CockpitPendingChangeResponse
	for _, row := range listChanges(t, wsID) {
		if row.Status == "pending" {
			open = append(open, row)
		}
	}
	if len(open) != 1 {
		t.Fatalf("queue holds %d open rows, want exactly one: %+v", len(open), open)
	}
	return open[0].ID
}

func decideChange(t *testing.T, wsID, id, verb string, want int) CockpitPendingChangeResponse {
	t.Helper()
	var decide http.HandlerFunc
	switch verb {
	case "reject":
		decide = testHandler.RejectCockpitChange
	case "withdraw":
		decide = testHandler.WithdrawCockpitChange
	default:
		t.Fatalf("decideChange: unsupported verb %q (apply has its own response shape)", verb)
	}
	var out CockpitPendingChangeResponse
	testutil.Call(t, cockpitHandler(decide),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPost, "/api/cockpit/changes/"+id+"/"+verb, wsID, nil),
			"changeId", id,
		)).
		Want(want).
		JSON(&out)
	return out
}

func TestCockpitNormalizeChangeValue(t *testing.T) {
	cases := []struct {
		field string
		in    string
		want  string
		ok    bool
	}{
		// Text passes through, trimmed; empty is a legal "clear it".
		{"name", "  协议签署 ", "协议签署", true},
		{"note", "", "", true},
		// Dates canonicalise to YYYY-MM-DD from either accepted spelling.
		{"start_date", "2026-09-05", "2026-09-05", true},
		{"start_date", "2026-09-05T00:00:00Z", "2026-09-05", true},
		{"start_date", "", "", true},
		{"start_date", "05/09/2026", "", false},
		{"start_date", "2026-13-01", "", false},
		// Numbers take their shortest form; progress has a range and no empty.
		{"progress", "12.50", "12.5", true},
		{"progress", "0", "0", true},
		{"progress", "", "", false},
		{"progress", "101", "", false},
		{"progress", "abc", "", false},
		// budget_amount may be emptied (clearing the budget line) and is
		// capped by the column's own precision.
		{"budget_amount", "", "", true},
		{"budget_amount", "1295.0", "1295", true},
		{"budget_amount", "1e14", "", false},
		// Not proposable at all.
		{"parent_id", "some-uuid", "", false},
		{"code", "L9-99", "", false},
	}
	for _, tc := range cases {
		got, ok := cockpitNormalizeChangeValue(tc.field, tc.in)
		if ok != tc.ok || got != tc.want {
			t.Errorf("normalize(%s, %q) = (%q, %v), want (%q, %v)",
				tc.field, tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestCockpitIngestJudgesEachProposal(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit ingest matrix")
	node := createNode(t, wsID, map[string]any{
		"code": "L3-01-08", "name": "协议签署", "status": "未开始",
		"progress": 25, "budget_amount": 30.5, "start_date": "2026-09-05",
	})

	out := ingestChanges(t, wsID, []map[string]any{
		// A real change: queued, carrying the current value for the diff.
		{"node": node.ID, "field": "status", "new_value": "进行中", "reason": "周会确认已启动"},
		// The same proposal again: the queue already says this.
		{"node": node.ID, "field": "status", "new_value": "进行中"},
		// States the present: noise for a reviewer.
		{"node": node.ID, "field": "progress", "new_value": "25"},
		// Tree shape is not proposable.
		{"node": node.ID, "field": "parent_id", "new_value": node.ID},
		// Unparseable and out-of-range values.
		{"node": node.ID, "field": "progress", "new_value": "half"},
		{"node": node.ID, "field": "progress", "new_value": "150"},
		{"node": node.ID, "field": "end_date", "new_value": "2026-13-40"},
		// No node answers to this code.
		{"node": "L9-99", "field": "status", "new_value": "已完成"},
		// Clearing a budget line is a proposal, not a no-op.
		{"node": node.ID, "field": "budget_amount", "new_value": ""},
	})

	want := []struct{ status, reason string }{
		{"queued", ""},
		{"skipped", "duplicate"},
		{"skipped", "no_change"},
		{"rejected", "invalid_field"},
		{"rejected", "invalid_value"},
		{"rejected", "invalid_value"},
		{"rejected", "invalid_value"},
		{"rejected", "unknown_node"},
		{"queued", ""},
	}
	if len(out.Results) != len(want) {
		t.Fatalf("ingest returned %d results, want %d", len(out.Results), len(want))
	}
	for i, w := range want {
		got := out.Results[i]
		if got.Status != w.status || got.Reason != w.reason {
			t.Errorf("result %d = %s/%s, want %s/%s", i, got.Status, got.Reason, w.status, w.reason)
		}
	}

	// Exactly the two distinct proposals made it into the queue, with the
	// board's values snapshotted as old_value.
	rows := listChanges(t, wsID)
	if len(rows) != 2 {
		t.Fatalf("queue holds %d rows, want 2: %+v", len(rows), rows)
	}
	byField := map[string]CockpitPendingChangeResponse{}
	for _, row := range rows {
		byField[row.Field] = row
	}
	if c := byField["status"]; c.OldValue != "未开始" || c.NewValue != "进行中" || c.Source != "manual" {
		t.Errorf("status change = %+v", c)
	}
	if c := byField["budget_amount"]; c.OldValue != "30.5" || c.NewValue != "" {
		t.Errorf("budget_amount change = %+v", c)
	}

	// And nothing moved on the board itself.
	board := getBoard(t, wsID)
	if board.Nodes[0].Status != "未开始" || board.Nodes[0].BudgetAmount == nil {
		t.Errorf("ingest moved the board: %+v", board.Nodes[0])
	}
}

func TestCockpitIngestReplacesOpenProposal(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit ingest replaces open proposal")
	createNode(t, wsID, map[string]any{"code": "L1-02", "name": "队列去重", "status": "未开始"})

	// Addressed by code, not UUID — agents report codes, and so do people.
	out := ingestChanges(t, wsID, []map[string]any{
		{"node": "L1-02", "field": "status", "new_value": "进行中"},
	})
	if out.Results[0].Status != "queued" {
		t.Fatalf("first ingest = %s, want queued", out.Results[0].Status)
	}

	// A newer observation for the same field replaces the proposal; the queue
	// never shows two competing values for one field.
	out = ingestChanges(t, wsID, []map[string]any{
		{"node": "L1-02", "field": "status", "new_value": "已完成"},
	})
	if out.Results[0].Status != "updated" {
		t.Fatalf("second ingest = %s, want updated", out.Results[0].Status)
	}

	rows := listChanges(t, wsID)
	if len(rows) != 1 || rows[0].NewValue != "已完成" {
		t.Fatalf("queue = %+v, want one row proposing 已完成", rows)
	}

	// A decided row no longer blocks a fresh proposal for the same field.
	decideChange(t, wsID, rows[0].ID, "reject", http.StatusOK)
	out = ingestChanges(t, wsID, []map[string]any{
		{"node": "L1-02", "field": "status", "new_value": "进行中"},
	})
	if out.Results[0].Status != "queued" {
		t.Fatalf("ingest after decision = %s, want queued", out.Results[0].Status)
	}
}

func TestCockpitApplyWritesTheFieldAndCloses(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit apply")
	node := createNode(t, wsID, map[string]any{
		"code": "L3-02-01", "name": "分子筛选", "status": "进行中", "progress": 40,
	})
	ingestChanges(t, wsID, []map[string]any{
		{"node": node.ID, "field": "progress", "new_value": "80"},
	})

	var applied CockpitChangeApplyResponse
	testutil.Call(t, cockpitHandler(testHandler.ApplyCockpitChange),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPost, "/api/cockpit/changes/x/apply", wsID, nil),
			"changeId", changeID(t, wsID),
		)).
		Want(http.StatusOK).
		JSON(&applied)

	if applied.Change.Status != "applied" {
		t.Errorf("change status = %s, want applied", applied.Change.Status)
	}
	if applied.Change.OldValue != "40" {
		t.Errorf("old_value = %q, want the value actually overwritten", applied.Change.OldValue)
	}
	if applied.Node.Progress != 80 {
		t.Errorf("node progress = %v, want 80", applied.Node.Progress)
	}

	// The board moved, through the same handler everyone else edits with.
	board := getBoard(t, wsID)
	if board.Nodes[0].Progress != 80 {
		t.Errorf("board progress = %v, want 80", board.Nodes[0].Progress)
	}

	// A decision is one-way: applying again answers 409, not twice.
	testutil.Call(t, cockpitHandler(testHandler.ApplyCockpitChange),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPost, "/api/cockpit/changes/"+applied.Change.ID+"/apply", wsID, nil),
			"changeId", applied.Change.ID,
		)).
		Want(http.StatusConflict)
}

// The proposal queues a snapshot; the human decides later, against a board
// that may have moved underneath it. Apply records what it really overwrote —
// the history must read true, not replay the queue's stale memory.
func TestCockpitApplyRecordsTheMovedBoard(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit apply against moved board")
	node := createNode(t, wsID, map[string]any{"code": "L1-03", "name": "竞争编辑", "status": "未开始"})
	ingestChanges(t, wsID, []map[string]any{
		{"node": node.ID, "field": "status", "new_value": "进行中"},
	})

	// Someone edits the field directly while the proposal waits.
	var patched CockpitNodeResponse
	testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitNode),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPatch, "/api/cockpit/nodes/"+node.ID, wsID,
				map[string]any{"status": "受阻"}),
			"id", node.ID,
		)).
		Want(http.StatusOK).
		JSON(&patched)

	var applied CockpitChangeApplyResponse
	testutil.Call(t, cockpitHandler(testHandler.ApplyCockpitChange),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPost, "/api/cockpit/changes/x/apply", wsID, nil),
			"changeId", changeID(t, wsID),
		)).
		Want(http.StatusOK).
		JSON(&applied)

	if applied.Change.OldValue != "受阻" {
		t.Errorf("old_value = %q, want the live value it overwrote (受阻)", applied.Change.OldValue)
	}
	if applied.Node.Status != "进行中" {
		t.Errorf("node status = %q, want 进行中", applied.Node.Status)
	}
}

func TestCockpitRejectAndWithdrawLeaveBoardAlone(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit reject and withdraw")
	node := createNode(t, wsID, map[string]any{"code": "L2-01", "name": "驳回路径", "status": "未开始"})
	ingestChanges(t, wsID, []map[string]any{
		{"node": node.ID, "field": "status", "new_value": "进行中"},
	})

	rejected := decideChange(t, wsID, changeID(t, wsID), "reject", http.StatusOK)
	if rejected.Status != "rejected" || rejected.DecidedByLabel == "" {
		t.Errorf("rejected change = %+v", rejected)
	}
	if board := getBoard(t, wsID); board.Nodes[0].Status != "未开始" {
		t.Errorf("reject moved the board: %q", board.Nodes[0].Status)
	}

	// Withdraw is the proposer's exit, same state machine.
	ingestChanges(t, wsID, []map[string]any{
		{"node": node.ID, "field": "progress", "new_value": "90"},
	})
	withdrawn := decideChange(t, wsID, changeID(t, wsID), "withdraw", http.StatusOK)
	if withdrawn.Status != "withdrawn" {
		t.Errorf("withdrawn change = %+v", withdrawn)
	}
	if board := getBoard(t, wsID); board.Nodes[0].Progress != 0 {
		t.Errorf("withdraw moved the board: %v", board.Nodes[0].Progress)
	}

	// Applying a withdrawn row is a 409, same as any second decision.
	testutil.Call(t, cockpitHandler(testHandler.ApplyCockpitChange),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPost, "/api/cockpit/changes/"+withdrawn.ID+"/apply", wsID, nil),
			"changeId", withdrawn.ID,
		)).
		Want(http.StatusConflict)
}

func TestCockpitSingleChangeEndpoint(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit single change endpoint")
	createNode(t, wsID, map[string]any{"code": "L1-04", "name": "单条提交", "status": "未开始"})

	// The human entry: one proposal, answered as one row.
	var filed CockpitPendingChangeResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitChange),
		cockpitRequest(http.MethodPost, "/api/cockpit/changes", wsID, map[string]any{
			"node": "L1-04", "field": "end_date", "new_value": "2026-12-31",
			"reason": "立项批复延后",
		})).
		Want(http.StatusCreated).
		JSON(&filed)
	if filed.NodeCode != "L1-04" || filed.NewValue != "2026-12-31" || filed.OldValue != "" {
		t.Errorf("filed change = %+v", filed)
	}

	// Filing what the board already says answers 200 with the reason, so the
	// form can say "already current" without parsing prose.
	var resp CockpitIngestResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitChange),
		cockpitRequest(http.MethodPost, "/api/cockpit/changes", wsID, map[string]any{
			"node": "L1-04", "field": "end_date", "new_value": "2026-12-31",
		})).
		Want(http.StatusOK).
		JSON(&resp)
	if resp.Results[0].Status != "skipped" || resp.Results[0].Reason != "duplicate" {
		t.Errorf("duplicate filing = %+v", resp.Results[0])
	}

	// Unknown fields and values stay 400s on this endpoint.
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitChange),
		cockpitRequest(http.MethodPost, "/api/cockpit/changes", wsID, map[string]any{
			"node": "L1-04", "field": "position", "new_value": "5",
		})).
		Want(http.StatusBadRequest)
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitChange),
		cockpitRequest(http.MethodPost, "/api/cockpit/changes", wsID, map[string]any{
			"node": "L1-04", "field": "progress", "new_value": "200",
		})).
		Want(http.StatusBadRequest)
	// A node that is not on this board is a 404, same as everywhere.
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitChange),
		cockpitRequest(http.MethodPost, "/api/cockpit/changes", wsID, map[string]any{
			"node": "L9-99", "field": "status", "new_value": "已完成",
		})).
		Want(http.StatusNotFound)
}

func TestCockpitNodeDeleteClearsChanges(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit node delete clears changes")
	node := createNode(t, wsID, map[string]any{"code": "L1-05", "name": "删除清队", "status": "未开始"})
	ingestChanges(t, wsID, []map[string]any{
		{"node": node.ID, "field": "status", "new_value": "进行中"},
	})

	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitNode),
		testutil.WithURLParams(
			cockpitRequest(http.MethodDelete, "/api/cockpit/nodes/"+node.ID, wsID, nil),
			"id", node.ID,
		)).
		Want(http.StatusNoContent)

	if rows := listChanges(t, wsID); len(rows) != 0 {
		t.Errorf("deleted node left %d change rows behind", len(rows))
	}
}
