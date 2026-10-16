package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
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

// TestCockpitChangesAttributeTheSourceTask locks the attribution contract: a
// proposal filed under a task identity remembers the task, the queue and the
// review preview name the issue that task runs on, a hand-filed proposal has
// no source, and a re-ingest re-stamps the source with the latest intent.
func TestCockpitChangesAttributeTheSourceTask(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit change attribution")
	node := createNode(t, wsID, map[string]any{"code": "L3-AT-1", "name": "归因验证", "status": "未开始"})

	// Filed by hand: no source at all.
	ingestChanges(t, wsID, []map[string]any{{"node": node.ID, "field": "status", "new_value": "进行中", "reason": "人工登记"}})
	hand := listChanges(t, wsID)[0]
	if hand.SourceTaskID != "" || hand.SourceIssue != nil {
		t.Fatalf("hand-filed proposal carried a source: %+v", hand)
	}

	// Filed from a task: the queue names the task's issue.
	runtimeID := dbfx.Runtime(t, "attr-runtime")
	agentID := dbfx.Agent(t, "归因智能体", runtimeID, testutil.Cols{"workspace_id": wsID, "visibility": "workspace"})
	issueID := dbfx.Issue(t, "会议纪要核对", testutil.Cols{"workspace_id": wsID})
	taskID := dbfx.Task(t, agentID, testutil.Cols{"issue_id": issueID, "runtime_id": runtimeID})

	req := cockpitRequest(http.MethodPost, "/api/cockpit/changes/ingest", wsID,
		map[string]any{"changes": []map[string]any{{"node": node.ID, "field": "progress", "new_value": "40", "reason": "纪要确认 40%"}}})
	req.Header.Set("X-Task-ID", taskID)
	var ingestOut CockpitIngestResponse
	testutil.Call(t, cockpitHandler(testHandler.IngestCockpitChanges), req).Want(http.StatusOK).JSON(&ingestOut)
	if ingestOut.Results[0].Status != "queued" {
		t.Fatalf("ingest from task = %s/%s", ingestOut.Results[0].Status, ingestOut.Results[0].Reason)
	}

	var attributed CockpitPendingChangeResponse
	for _, row := range listChanges(t, wsID) {
		if row.Field == "progress" {
			attributed = row
		}
	}
	if attributed.SourceTaskID != taskID {
		t.Errorf("source task = %q, want %q", attributed.SourceTaskID, taskID)
	}
	if attributed.SourceIssue == nil || attributed.SourceIssue.Ref != "TES-1" || attributed.SourceIssue.Title != "会议纪要核对" || attributed.SourceIssue.ID != issueID {
		t.Errorf("source issue = %+v, want TES-1 会议纪要核对 (%s)", attributed.SourceIssue, issueID)
	}

	// The review preview carries the same context for the reviewing human.
	var preview CockpitChangeReviewPreview
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitChangePreview),
		testutil.WithURLParams(cockpitRequest(http.MethodGet, "/api/cockpit/changes/"+attributed.ID+"/preview", wsID, nil), "changeId", attributed.ID)).
		Want(http.StatusOK).
		JSON(&preview)
	if preview.Change.SourceIssue == nil || preview.Change.SourceIssue.Ref != "TES-1" {
		t.Errorf("preview source issue = %+v", preview.Change.SourceIssue)
	}

	// The paged queue folds the raw join columns into the same wire shape.
	var page struct {
		Items []json.RawMessage `json:"items"`
	}
	testutil.Call(t, cockpitHandler(testHandler.ListCockpitChangePage),
		cockpitRequest(http.MethodGet, "/api/cockpit/changes/page?status=all&page_size=50", wsID, nil)).
		Want(http.StatusOK).
		JSON(&page)
	found := false
	for _, item := range page.Items {
		var m map[string]any
		if err := json.Unmarshal(item, &m); err != nil {
			t.Fatalf("page item is not an object: %v", err)
		}
		if _, leaked := m["source_issue_id"]; leaked {
			t.Errorf("raw source_issue_id leaked into the page item: %s", item)
		}
		if m["field"] == "progress" {
			found = true
			source, ok := m["source_issue"].(map[string]any)
			if !ok || source["ref"] != "TES-1" || source["title"] != "会议纪要核对" || source["id"] != issueID {
				t.Errorf("page source_issue = %v", m["source_issue"])
			}
		}
	}
	if !found {
		t.Fatal("progress proposal missing from the paged queue")
	}

	// A re-ingest is the latest intent: its source task replaces the stamp.
	runtimeID2 := dbfx.Runtime(t, "attr-runtime-2")
	agentID2 := dbfx.Agent(t, "归因智能体二", runtimeID2, testutil.Cols{"workspace_id": wsID, "visibility": "workspace"})
	issueID2 := dbfx.Issue(t, "供应商台账核对", testutil.Cols{"workspace_id": wsID})
	taskID2 := dbfx.Task(t, agentID2, testutil.Cols{"issue_id": issueID2, "runtime_id": runtimeID2})
	req2 := cockpitRequest(http.MethodPost, "/api/cockpit/changes/ingest", wsID,
		map[string]any{"changes": []map[string]any{{"node": node.ID, "field": "progress", "new_value": "55", "reason": "第二任务更新证据"}}})
	req2.Header.Set("X-Task-ID", taskID2)
	var reingest CockpitIngestResponse
	testutil.Call(t, cockpitHandler(testHandler.IngestCockpitChanges), req2).Want(http.StatusOK).JSON(&reingest)
	if reingest.Results[0].Status != "updated" {
		t.Fatalf("re-ingest = %s/%s, want updated", reingest.Results[0].Status, reingest.Results[0].Reason)
	}
	for _, row := range listChanges(t, wsID) {
		if row.Field == "progress" {
			if row.SourceTaskID != taskID2 || row.SourceIssue == nil || row.SourceIssue.Ref != "TES-2" {
				t.Errorf("re-ingest did not re-stamp the source: %+v", row.SourceIssue)
			}
		}
	}
}

// TestCockpitAgentProposalsRequireAReason locks the necessity gate: a
// task-credential ingest without a reason is rejected per row (one bad row
// never poisons the batch), humans stay optional, and a redundant
// observation is judged no_change before any reason requirement applies.
func TestCockpitAgentProposalsRequireAReason(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit reason gate")
	node := createNode(t, wsID, map[string]any{"code": "L3-RS-1", "progress": 10})

	ingestWith := func(source string, changes []map[string]any) CockpitIngestResponse {
		t.Helper()
		req := cockpitRequest(http.MethodPost, "/api/cockpit/changes/ingest", wsID, map[string]any{"changes": changes})
		if source != "" {
			req.Header.Set("X-Actor-Source", source)
		}
		var out CockpitIngestResponse
		testutil.Call(t, cockpitHandler(testHandler.IngestCockpitChanges), req).Want(http.StatusOK).JSON(&out)
		return out
	}

	out := ingestWith("task_token", []map[string]any{
		{"node": node.ID, "field": "status", "new_value": "进行中"},
		{"node": node.ID, "field": "progress", "new_value": "40", "reason": "纪要确认 40%"},
	})
	if out.Results[0].Status != "rejected" || out.Results[0].Reason != "reason_required" {
		t.Errorf("unreasoned agent proposal = %s/%s, want rejected/reason_required", out.Results[0].Status, out.Results[0].Reason)
	}
	if out.Results[1].Status != "queued" {
		t.Errorf("reasoned agent proposal = %s/%s, want queued", out.Results[1].Status, out.Results[1].Reason)
	}

	// Humans stay optional; a redundant observation is not failed for a
	// missing reason — it is not a proposal at all.
	out = ingestWith("", []map[string]any{
		{"node": node.ID, "field": "progress", "new_value": "10"},
		{"node": node.ID, "field": "status", "new_value": "未开始"},
	})
	if out.Results[0].Status != "skipped" || out.Results[0].Reason != "no_change" {
		t.Errorf("human redundant observation = %s/%s, want skipped/no_change", out.Results[0].Status, out.Results[0].Reason)
	}
	if out.Results[1].Status != "queued" {
		t.Errorf("human unreasoned proposal = %s/%s, want queued", out.Results[1].Status, out.Results[1].Reason)
	}

	// Oversized reasons are rejected, never silently truncated.
	out = ingestWith("task_token", []map[string]any{{"node": node.ID, "field": "deliverable", "new_value": "报告", "reason": strings.Repeat("证", 2001)}})
	if out.Results[0].Status != "rejected" || out.Results[0].Reason != "invalid_reason" {
		t.Errorf("oversized reason = %s/%s, want rejected/invalid_reason", out.Results[0].Status, out.Results[0].Reason)
	}

	// The single-proposal endpoint surfaces the same gate as a 400.
	req := cockpitRequest(http.MethodPost, "/api/cockpit/changes", wsID,
		map[string]any{"node": node.ID, "field": "note", "new_value": "补充说明"})
	req.Header.Set("X-Actor-Source", "task_token")
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitChange), req).Want(http.StatusBadRequest)
}

// TestCockpitNodeDirectEditsRequireHuman locks the write path around the
// governance queue: machine credentials can no longer PATCH plan nodes
// directly (they propose, a human applies), and the node's audit column
// records the real actor instead of a hardcoded "member".
func TestCockpitNodeDirectEditsRequireHuman(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit direct edit gate")
	node := createNode(t, wsID, map[string]any{"code": "L3-GT-1", "name": "闸门验证"})

	patch := func(source string) *testutil.Response {
		t.Helper()
		req := testutil.WithURLParams(
			cockpitRequest(http.MethodPatch, "/api/cockpit/nodes/"+node.ID, wsID, map[string]any{"name": "改名"}),
			"id", node.ID)
		if source != "" {
			req.Header.Set("X-Actor-Source", source)
		}
		return testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitNode), req)
	}
	for _, source := range []string{"task_token", "cloud_pat"} {
		patch(source).Want(http.StatusForbidden)
	}
	patch("").Want(http.StatusOK)
	if board := getBoard(t, wsID); board.Nodes[0].Name != "改名" {
		t.Fatalf("human patch did not apply: %+v", board.Nodes[0])
	}

	// The audit column tells the truth about who wrote: an agent-created
	// node stamps "agent", not the old hardcoded "member".
	runtimeID := dbfx.Runtime(t, "gate-runtime")
	agentID := dbfx.Agent(t, "建点智能体", runtimeID, testutil.Cols{"workspace_id": wsID, "visibility": "workspace"})
	req := cockpitRequest(http.MethodPost, "/api/cockpit/nodes", wsID,
		map[string]any{"code": "L3-GT-2", "name": "agent 创建"})
	req.Header.Set("X-Actor-Source", "task_token")
	req.Header.Set("X-Agent-ID", agentID)
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitNode), req).Want(http.StatusCreated)
	var writerType string
	dbfx.QueryRow(t, `SELECT updated_by_type FROM cockpit_node WHERE workspace_id = $1 AND code = 'L3-GT-2'`, wsID).Scan(&writerType)
	if writerType != "agent" {
		t.Errorf("updated_by_type = %q, want agent", writerType)
	}
}

// TestCockpitImportKeepsChangeHistory locks the second half of the history
// contract: a whole-board import closes pending proposals as system
// withdrawals (noting the import) and leaves decided rows untouched.
func TestCockpitImportKeepsChangeHistory(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit import keeps history")
	node := createNode(t, wsID, map[string]any{"code": "L1-07", "name": "导入保留", "status": "未开始"})
	ingestChanges(t, wsID, []map[string]any{{"node": node.ID, "field": "status", "new_value": "进行中"}})
	openID := changeID(t, wsID)
	decideChange(t, wsID, openID, "reject", http.StatusOK)
	ingestChanges(t, wsID, []map[string]any{{"node": node.ID, "field": "progress", "new_value": "70", "reason": "导入前"}})

	var importResp CockpitImportResponse
	testutil.Call(t, cockpitHandler(testHandler.ImportCockpit),
		cockpitRequest(http.MethodPost, "/api/cockpit/import", wsID, map[string]any{
			"nodes": []map[string]any{{"code": "L1-07", "name": "导入保留", "status": "未开始"}},
		})).
		Want(http.StatusOK).
		JSON(&importResp)

	rows := listChanges(t, wsID)
	if len(rows) != 2 {
		t.Fatalf("queue holds %d rows after import, want the full history: %+v", len(rows), rows)
	}
	byStatus := map[string]CockpitPendingChangeResponse{}
	for _, row := range rows {
		byStatus[row.Status] = row
	}
	pending := byStatus["withdrawn"]
	if pending.DecidedByType != "system" || pending.DecisionNote != "board replaced by import" {
		t.Errorf("import-withdrawn proposal = %+v", pending)
	}
	rejected := byStatus["rejected"]
	if rejected.DecisionNote != "" || rejected.DecidedByType != "member" {
		t.Errorf("decided history after import = %+v, want it untouched", rejected)
	}

	// The replaced board starts with a free (node, field) slot: a fresh
	// proposal for the same code stacks as new history, never as a conflict.
	ingestChanges(t, wsID, []map[string]any{{"node": "L1-07", "field": "progress", "new_value": "80", "reason": "导入后"}})
	if got := listChanges(t, wsID); len(got) != 3 {
		t.Fatalf("queue holds %d rows after re-proposal, want 3", len(got))
	}
}

// TestCockpitChangeDecisionReceipts lock the loop-closing contract: apply and
// reject both leave a system comment on the source task's issue, the rejection
// note travels with the rejection, and proposals without a source stay silent.
func TestCockpitChangeDecisionReceipts(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit decision receipts")
	node := createNode(t, wsID, map[string]any{"code": "L3-RC-1", "progress": 10})

	runtimeID := dbfx.Runtime(t, "receipt-runtime")
	agentID := dbfx.Agent(t, "回执智能体", runtimeID, testutil.Cols{"workspace_id": wsID, "visibility": "workspace"})
	issueID := dbfx.Issue(t, "驾驶舱核对任务", testutil.Cols{"workspace_id": wsID})
	taskID := dbfx.Task(t, agentID, testutil.Cols{"issue_id": issueID, "runtime_id": runtimeID})

	comments := func() []string {
		t.Helper()
		rows, err := testPool.Query(context.Background(), `SELECT content FROM comment WHERE issue_id = $1 AND author_type = 'system' ORDER BY created_at`, issueID)
		if err != nil {
			t.Fatalf("query system comments: %v", err)
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var c string
			if err := rows.Scan(&c); err != nil {
				t.Fatal(err)
			}
			out = append(out, c)
		}
		return out
	}

	// Apply: the source task hears the acceptance.
	file := func(newValue string) string {
		t.Helper()
		req := cockpitRequest(http.MethodPost, "/api/cockpit/changes/ingest", wsID,
			map[string]any{"changes": []map[string]any{{"node": node.ID, "field": "progress", "new_value": newValue, "reason": "证据更新"}}})
		req.Header.Set("X-Task-ID", taskID)
		testutil.Call(t, cockpitHandler(testHandler.IngestCockpitChanges), req).Want(http.StatusOK)
		return changeID(t, wsID)
	}

	applied := previewCockpitChange(t, wsID, file("40"))
	var accept CockpitChangeApplyResponse
	applyReviewedChange(t, wsID, applied, 200).JSON(&accept)
	if got := comments(); len(got) != 1 || !strings.Contains(got[0], "Plan update accepted") {
		t.Fatalf("accept receipt = %v", got)
	}

	// Reject with a note: the reason reaches the task that asked.
	rejected := file("90")
	var rejectedResp CockpitPendingChangeResponse
	testutil.Call(t, cockpitHandler(testHandler.RejectCockpitChange),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPost, "/api/cockpit/changes/"+rejected+"/reject", wsID, map[string]any{"note": "证据不足，请补充纪要来源"}),
			"changeId", rejected,
		)).
		Want(http.StatusOK).
		JSON(&rejectedResp)
	if rejectedResp.DecisionNote != "证据不足，请补充纪要来源" {
		t.Errorf("decision note = %q", rejectedResp.DecisionNote)
	}
	got := comments()
	if len(got) != 2 || !strings.Contains(got[1], "Plan update rejected") || !strings.Contains(got[1], "证据不足") {
		t.Fatalf("reject receipt = %v", got)
	}

	// A hand-filed proposal has no source task: deciding it is silent.
	ingestChanges(t, wsID, []map[string]any{{"node": node.ID, "field": "status", "new_value": "进行中"}})
	handID := changeID(t, wsID)
	decideChange(t, wsID, handID, "reject", http.StatusOK)
	if got := comments(); len(got) != 2 {
		t.Errorf("hand-filed decision produced receipts: %v", got)
	}

	// An oversized note is a client error, not a truncated receipt.
	file("95")
	oversized := changeID(t, wsID)
	testutil.Call(t, cockpitHandler(testHandler.RejectCockpitChange),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPost, "/api/cockpit/changes/"+oversized+"/reject", wsID, map[string]any{"note": strings.Repeat("字", 501)}),
			"changeId", oversized,
		)).
		Want(http.StatusBadRequest)
}

// TestCockpitMachineWithdrawOwnsItsSource closes the last open write: a
// machine credential may withdraw only what its own task filed, while humans
// keep the existing freedom.
func TestCockpitMachineWithdrawOwnsItsSource(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit machine withdraw gate")
	node := createNode(t, wsID, map[string]any{"code": "L3-WD-1"})

	runtimeID := dbfx.Runtime(t, "wd-runtime")
	agentID := dbfx.Agent(t, "撤回智能体", runtimeID, testutil.Cols{"workspace_id": wsID, "visibility": "workspace"})
	issueID := dbfx.Issue(t, "撤回任务一", testutil.Cols{"workspace_id": wsID})
	taskID := dbfx.Task(t, agentID, testutil.Cols{"issue_id": issueID, "runtime_id": runtimeID})
	issueID2 := dbfx.Issue(t, "撤回任务二", testutil.Cols{"workspace_id": wsID})
	taskID2 := dbfx.Task(t, agentID, testutil.Cols{"issue_id": issueID2, "runtime_id": runtimeID})

	fileFrom := func(task string) string {
		t.Helper()
		req := cockpitRequest(http.MethodPost, "/api/cockpit/changes/ingest", wsID,
			map[string]any{"changes": []map[string]any{{"node": node.ID, "field": "progress", "new_value": "30", "reason": "证据"}}})
		req.Header.Set("X-Task-ID", task)
		testutil.Call(t, cockpitHandler(testHandler.IngestCockpitChanges), req).Want(http.StatusOK)
		rows := listChanges(t, wsID)
		return rows[0].ID
	}

	mine := fileFrom(taskID)

	// Another task's machine cannot vacuum this one.
	req := testutil.WithURLParams(
		cockpitRequest(http.MethodPost, "/api/cockpit/changes/"+mine+"/withdraw", wsID, nil),
		"changeId", mine)
	req.Header.Set("X-Actor-Source", "task_token")
	req.Header.Set("X-Task-ID", taskID2)
	testutil.Call(t, cockpitHandler(testHandler.WithdrawCockpitChange), req).Want(http.StatusForbidden)

	// Its own task can.
	req = testutil.WithURLParams(
		cockpitRequest(http.MethodPost, "/api/cockpit/changes/"+mine+"/withdraw", wsID, nil),
		"changeId", mine)
	req.Header.Set("X-Actor-Source", "task_token")
	req.Header.Set("X-Task-ID", taskID)
	testutil.Call(t, cockpitHandler(testHandler.WithdrawCockpitChange), req).Want(http.StatusOK)

	// And a human still withdraws anything open.
	other := fileFrom(taskID2)
	decideChange(t, wsID, other, "withdraw", http.StatusOK)
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
		{"budget_amount", "1e10", "", false},
		{"budget_amount", "0.00001", "", false},
		{"budget_amount", "1.23456", "", false},
		{"budget_amount", "-12.3456", "-12.3456", true},
		{"budget_amount", "0.0001", "0.0001", true},
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

// TestCockpitNodeDeleteWithdrawsOpenChanges locks the "every governance
// request is saved" contract: deleting a node closes its still-pending
// proposals as system withdrawals (with the reason recorded) and keeps the
// decided history — nothing about the queue is hard-deleted with the node.
func TestCockpitNodeDeleteWithdrawsOpenChanges(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit node delete keeps change history")
	node := createNode(t, wsID, map[string]any{"code": "L1-05", "name": "删除清队", "status": "未开始"})
	ingestChanges(t, wsID, []map[string]any{
		{"node": node.ID, "field": "status", "new_value": "进行中"},
	})
	openID := changeID(t, wsID)
	decideChange(t, wsID, openID, "reject", http.StatusOK)

	// A second open proposal, decided by the deletion itself.
	ingestChanges(t, wsID, []map[string]any{
		{"node": node.ID, "field": "progress", "new_value": "60", "reason": "待删"},
	})

	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitNode),
		testutil.WithURLParams(
			cockpitRequest(http.MethodDelete, "/api/cockpit/nodes/"+node.ID, wsID, nil),
			"id", node.ID,
		)).
		Want(http.StatusNoContent)

	rows := listChanges(t, wsID)
	if len(rows) != 2 {
		t.Fatalf("queue holds %d rows after node deletion, want the full history: %+v", len(rows), rows)
	}
	byField := map[string]CockpitPendingChangeResponse{}
	for _, row := range rows {
		byField[row.Field] = row
	}
	pending := byField["progress"]
	if pending.Status != "withdrawn" || pending.DecidedByType != "system" || pending.DecisionNote != "node deleted" {
		t.Errorf("open proposal after deletion = %+v, want system withdrawal with the reason", pending)
	}
	rejected := byField["status"]
	if rejected.Status != "rejected" || rejected.DecidedByType != "member" || rejected.DecisionNote != "" {
		t.Errorf("decided history after deletion = %+v, want the human decision untouched", rejected)
	}
}
