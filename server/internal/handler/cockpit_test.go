package handler

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func cockpitRequest(method, path, workspaceID string, body any) *http.Request {
	return testutil.WithHeaders(
		testutil.JSONRequest(method, path, body),
		"X-User-ID", testUserID,
		"X-Workspace-ID", workspaceID,
	)
}

func cockpitHandler(handler http.HandlerFunc) http.HandlerFunc {
	return middleware.RequireWorkspaceMember(testHandler.Queries)(handler).ServeHTTP
}

// cockpitFixture builds a workspace with issue_prefix TES so linked issues
// render as TES-1, TES-2, … in insertion order.
func cockpitFixture(t *testing.T, name string) string {
	t.Helper()
	wsID := dbfx.Workspace(t, name, "cockpit-"+uuid.NewString(), testutil.Cols{
		"issue_prefix": "TES",
	})
	dbfx.Member(t, wsID, testUserID, "owner")
	t.Cleanup(func() {
		dbfx.Exec(t, "DELETE FROM cockpit_pending_change WHERE workspace_id = $1", wsID)
		dbfx.Exec(t, "DELETE FROM cockpit_snapshot WHERE workspace_id = $1", wsID)
		dbfx.Exec(t, "DELETE FROM cockpit_node_issue WHERE workspace_id = $1", wsID)
		dbfx.Exec(t, "DELETE FROM cockpit_payment WHERE workspace_id = $1", wsID)
		dbfx.Exec(t, "DELETE FROM cockpit_milestone WHERE workspace_id = $1", wsID)
		dbfx.Exec(t, "DELETE FROM cockpit_meeting WHERE workspace_id = $1", wsID)
		dbfx.Exec(t, "DELETE FROM cockpit_node WHERE workspace_id = $1", wsID)
		dbfx.Exec(t, "DELETE FROM cockpit WHERE workspace_id = $1", wsID)
	})
	return wsID
}

func getBoard(t *testing.T, wsID string) CockpitBoardResponse {
	t.Helper()
	var board CockpitBoardResponse
	testutil.Call(t, cockpitHandler(testHandler.GetCockpit),
		cockpitRequest(http.MethodGet, "/api/cockpit", wsID, nil)).
		Want(http.StatusOK).
		JSON(&board)
	return board
}

func createNode(t *testing.T, wsID string, body map[string]any) CockpitNodeResponse {
	t.Helper()
	var node CockpitNodeResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitNode),
		cockpitRequest(http.MethodPost, "/api/cockpit/nodes", wsID, body)).
		Want(http.StatusCreated).
		JSON(&node)
	return node
}

func TestGetCockpitCreatesTheBoardOnFirstRead(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit first read")

	board := getBoard(t, wsID)
	if board.Cockpit.ID == "" {
		t.Fatal("first read returned no cockpit id")
	}
	if board.Cockpit.WorkspaceID != wsID {
		t.Errorf("workspace_id = %q, want %q", board.Cockpit.WorkspaceID, wsID)
	}
	if len(board.Nodes) != 0 || len(board.Milestones) != 0 || len(board.Meetings) != 0 {
		t.Errorf("fresh board is not empty: %+v", board)
	}

	// Second read must land on the same row, not mint a second board.
	again := getBoard(t, wsID)
	if again.Cockpit.ID != board.Cockpit.ID {
		t.Errorf("second read created a new cockpit: %q then %q", board.Cockpit.ID, again.Cockpit.ID)
	}
}

func TestCockpitNodeCreateUpdateDelete(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit node lifecycle")

	parent := createNode(t, wsID, map[string]any{
		"code": "L1-01", "name": "高质量数据集", "owner": "李青娇", "color": "#2563eb",
	})
	child := createNode(t, wsID, map[string]any{
		"code": "L3-01-08", "parent_id": parent.ID, "name": "协议签署",
		"start_date": "2026-09-05", "end_date": "2026-09-20",
		"status": "未开始", "progress": 25, "budget_amount": 30.5,
	})

	if child.ParentID == nil || *child.ParentID != parent.ID {
		t.Fatalf("child parent_id = %v, want %s", child.ParentID, parent.ID)
	}
	if child.StartDate == nil || *child.StartDate != "2026-09-05" {
		t.Errorf("start_date = %v, want 2026-09-05", child.StartDate)
	}
	if child.BudgetAmount == nil || *child.BudgetAmount != 30.5 {
		t.Errorf("budget_amount = %v, want 30.5", child.BudgetAmount)
	}

	// A node addressed by its human code, not its UUID.
	var updated CockpitNodeResponse
	testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitNode),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPatch, "/api/cockpit/nodes/L3-01-08", wsID, map[string]any{
				"progress": 60, "status": "进行中",
			}),
			"id", "L3-01-08",
		)).
		Want(http.StatusOK).
		JSON(&updated)
	if updated.Progress != 60 || updated.Status != "进行中" {
		t.Errorf("update by code = %+v", updated)
	}

	// Deleting a branch that still has children is refused, so one mis-clicked
	// row cannot take a module's subtree with it.
	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitNode),
		testutil.WithURLParams(
			cockpitRequest(http.MethodDelete, "/api/cockpit/nodes/"+parent.ID, wsID, nil),
			"id", parent.ID,
		)).
		Want(http.StatusConflict)

	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitNode),
		testutil.WithURLParams(
			cockpitRequest(http.MethodDelete, "/api/cockpit/nodes/"+child.ID, wsID, nil),
			"id", child.ID,
		)).
		Want(http.StatusNoContent)

	board := getBoard(t, wsID)
	if len(board.Nodes) != 1 || board.Nodes[0].Code != "L1-01" {
		t.Errorf("after delete nodes = %+v", board.Nodes)
	}
}

// Clearing a date is an edit, not the absence of one: a plan that withdraws a
// planned end must not silently keep the old one.
func TestCockpitNodeClearsDatesAndBudgetExplicitly(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit clear fields")
	node := createNode(t, wsID, map[string]any{
		"code": "T-1", "start_date": "2026-01-01", "end_date": "2026-02-01", "budget_amount": 12,
	})

	var afterUnrelated CockpitNodeResponse
	testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitNode),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPatch, "/api/cockpit/nodes/"+node.ID, wsID, map[string]any{"name": "renamed"}),
			"id", node.ID,
		)).
		Want(http.StatusOK).
		JSON(&afterUnrelated)
	if afterUnrelated.EndDate == nil || *afterUnrelated.EndDate != "2026-02-01" {
		t.Errorf("an unrelated edit dropped end_date: %v", afterUnrelated.EndDate)
	}
	if afterUnrelated.BudgetAmount == nil {
		t.Error("an unrelated edit dropped budget_amount")
	}

	var cleared CockpitNodeResponse
	testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitNode),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPatch, "/api/cockpit/nodes/"+node.ID, wsID, map[string]any{
				"end_date": nil, "budget_amount": nil,
			}),
			"id", node.ID,
		)).
		Want(http.StatusOK).
		JSON(&cleared)
	if cleared.EndDate != nil {
		t.Errorf("end_date = %v, want nil", cleared.EndDate)
	}
	if cleared.BudgetAmount != nil {
		t.Errorf("budget_amount = %v, want nil", cleared.BudgetAmount)
	}
	if cleared.StartDate == nil || *cleared.StartDate != "2026-01-01" {
		t.Errorf("start_date = %v, want it untouched", cleared.StartDate)
	}
}

func TestCockpitNodeRejectsBadInput(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit validation")
	node := createNode(t, wsID, map[string]any{"code": "V-1"})

	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitNode),
		cockpitRequest(http.MethodPost, "/api/cockpit/nodes", wsID, map[string]any{"name": "no code"})).
		Want(http.StatusBadRequest)

	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitNode),
		cockpitRequest(http.MethodPost, "/api/cockpit/nodes", wsID, map[string]any{"code": "V-1"})).
		Want(http.StatusConflict)

	testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitNode),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPatch, "/api/cockpit/nodes/"+node.ID, wsID, map[string]any{"progress": 140}),
			"id", node.ID,
		)).
		Want(http.StatusBadRequest)

	testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitNode),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPatch, "/api/cockpit/nodes/"+node.ID, wsID, map[string]any{"parent_id": node.ID}),
			"id", node.ID,
		)).
		Want(http.StatusBadRequest)

	testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitNode),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPatch, "/api/cockpit/nodes/"+node.ID, wsID, map[string]any{"start_date": "05/09/2026"}),
			"id", node.ID,
		)).
		Want(http.StatusBadRequest)
}

func TestCockpitNodeIssueLinksAcceptIdentifiersAndMultiSelect(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit issue links")
	first := dbfx.Issue(t, "First", testutil.Cols{"workspace_id": wsID})
	second := dbfx.Issue(t, "Second", testutil.Cols{"workspace_id": wsID})
	node := createNode(t, wsID, map[string]any{"code": "L3-01-01"})

	// A UUID and a workspace identifier in the same request: the board's own
	// vocabulary for an issue is "TES-2", not a UUID.
	var linked struct {
		Links []CockpitNodeIssueResponse `json:"links"`
	}
	testutil.Call(t, cockpitHandler(testHandler.SetCockpitNodeIssues),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPut, "/api/cockpit/nodes/"+node.ID+"/issues", wsID, map[string]any{
				"issue_ids": []string{first, "TES-2"},
			}),
			"id", node.ID,
		)).
		Want(http.StatusOK).
		JSON(&linked)

	if len(linked.Links) != 2 {
		t.Fatalf("links = %d, want 2: %+v", len(linked.Links), linked.Links)
	}
	byID := map[string]CockpitNodeIssueResponse{}
	for _, l := range linked.Links {
		byID[l.IssueID] = l
	}
	if l := byID[first]; l.IssueIdentifier != "TES-1" || l.IssueTitle != "First" {
		t.Errorf("first link = %+v", l)
	}
	if l := byID[second]; l.IssueIdentifier != "TES-2" {
		t.Errorf("second link = %+v", l)
	}

	// An unknown reference fails the whole request rather than linking half of
	// what was asked for.
	testutil.Call(t, cockpitHandler(testHandler.SetCockpitNodeIssues),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPut, "/api/cockpit/nodes/"+node.ID+"/issues", wsID, map[string]any{
				"issue_ids": []string{"TES-999"},
			}),
			"id", node.ID,
		)).
		Want(http.StatusBadRequest)

	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitNodeIssue),
		testutil.WithURLParams(
			cockpitRequest(http.MethodDelete, fmt.Sprintf("/api/cockpit/nodes/%s/issues/TES-1", node.ID), wsID, nil),
			"id", node.ID, "issueId", "TES-1",
		)).
		Want(http.StatusNoContent)

	board := getBoard(t, wsID)
	if len(board.IssueLinks) != 1 || board.IssueLinks[0].IssueID != second {
		t.Errorf("after unlink issue_links = %+v", board.IssueLinks)
	}
}

func TestCockpitPaymentsMilestonesAndMeetings(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit collections")
	node := createNode(t, wsID, map[string]any{"code": "P-1"})

	var payment CockpitPaymentResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitPayment),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPost, "/api/cockpit/nodes/"+node.ID+"/payments", wsID, map[string]any{
				"label": "第1笔", "pay_date": "2026-09-05", "amount": 15.25,
			}),
			"id", node.ID,
		)).
		Want(http.StatusCreated).
		JSON(&payment)
	if payment.Amount != 15.25 {
		t.Errorf("amount = %v, want 15.25", payment.Amount)
	}

	var milestone CockpitMilestoneResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitMilestone),
		cockpitRequest(http.MethodPost, "/api/cockpit/milestones", wsID, map[string]any{
			"name": "数据集验收", "plan_date": "2026-11-30", "status": "前置准备", "node_id": "P-1",
		})).
		Want(http.StatusCreated).
		JSON(&milestone)
	if milestone.NodeID == nil || *milestone.NodeID != node.ID {
		t.Errorf("milestone node_id = %v, want %s (resolved from code)", milestone.NodeID, node.ID)
	}

	var meeting CockpitMeetingResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitMeeting),
		cockpitRequest(http.MethodPost, "/api/cockpit/meetings", wsID, map[string]any{
			"title": "工作组周例会", "meet_date": "2026-09-01", "time_range": "10:00–11:00",
		})).
		Want(http.StatusCreated).
		JSON(&meeting)

	board := getBoard(t, wsID)
	if len(board.Payments) != 1 || len(board.Milestones) != 1 || len(board.Meetings) != 1 {
		t.Fatalf("board = %+v", board)
	}

	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitPayment),
		testutil.WithURLParams(
			cockpitRequest(http.MethodDelete, "/api/cockpit/payments/"+payment.ID, wsID, nil),
			"paymentId", payment.ID,
		)).
		Want(http.StatusNoContent)
	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitMilestone),
		testutil.WithURLParams(
			cockpitRequest(http.MethodDelete, "/api/cockpit/milestones/"+milestone.ID, wsID, nil),
			"milestoneId", milestone.ID,
		)).
		Want(http.StatusNoContent)
	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitMeeting),
		testutil.WithURLParams(
			cockpitRequest(http.MethodDelete, "/api/cockpit/meetings/"+meeting.ID, wsID, nil),
			"meetingId", meeting.ID,
		)).
		Want(http.StatusNoContent)

	empty := getBoard(t, wsID)
	if len(empty.Payments) != 0 || len(empty.Milestones) != 0 || len(empty.Meetings) != 0 {
		t.Errorf("after deletes board = %+v", empty)
	}
}

// Deleting a node must take its instalments and issue links with it — nothing
// in the schema cascades, so the handler owns that cleanup.
func TestDeleteCockpitNodeClearsItsOwnRows(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit node cleanup")
	issueID := dbfx.Issue(t, "Linked", testutil.Cols{"workspace_id": wsID})
	node := createNode(t, wsID, map[string]any{"code": "C-1"})

	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitPayment),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPost, "/api/cockpit/nodes/"+node.ID+"/payments", wsID, map[string]any{"amount": 5}),
			"id", node.ID,
		)).
		Want(http.StatusCreated)
	testutil.Call(t, cockpitHandler(testHandler.SetCockpitNodeIssues),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPut, "/api/cockpit/nodes/"+node.ID+"/issues", wsID, map[string]any{
				"issue_ids": []string{issueID},
			}),
			"id", node.ID,
		)).
		Want(http.StatusOK)

	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitNode),
		testutil.WithURLParams(
			cockpitRequest(http.MethodDelete, "/api/cockpit/nodes/"+node.ID, wsID, nil),
			"id", node.ID,
		)).
		Want(http.StatusNoContent)

	if n := dbfx.Count(t, "SELECT count(*) FROM cockpit_payment WHERE node_id = $1", node.ID); n != 0 {
		t.Errorf("orphaned payments = %d", n)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM cockpit_node_issue WHERE node_id = $1", node.ID); n != 0 {
		t.Errorf("orphaned issue links = %d", n)
	}
}

func TestImportCockpitReplacesTheBoard(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit import")
	dbfx.Issue(t, "Linked issue", testutil.Cols{"workspace_id": wsID})
	createNode(t, wsID, map[string]any{"code": "STALE-1", "name": "replaced"})

	var result CockpitImportResponse
	testutil.Call(t, cockpitHandler(testHandler.ImportCockpit),
		cockpitRequest(http.MethodPut, "/api/cockpit/import", wsID, map[string]any{
			"title":     "AI+医药数据平台驾驶舱",
			"goal_date": "2026-12-31",
			"nodes": []map[string]any{
				// Child before parent on purpose: the document need not be
				// topologically sorted.
				{
					"code": "L3-01-01", "parent_code": "L1-01", "name": "队列方案定稿",
					"start_date": "2026-09-01", "end_date": "2026-09-30", "progress": 40,
					"issue_ids": []string{"TES-1", "TES-404"},
					"payments":  []map[string]any{{"label": "第1笔", "pay_date": "2026-09-05", "amount": 15}},
				},
				{"code": "L1-01", "name": "高质量数据集", "color": "#2563eb"},
			},
			"milestones": []map[string]any{
				{"name": "验收", "plan_date": "2026-11-30", "node_code": "L1-01"},
			},
			"meetings": []map[string]any{{"title": "周例会", "meet_date": "2026-09-01"}},
		})).
		Want(http.StatusOK).
		JSON(&result)

	if result.Nodes != 2 || result.Payments != 1 || result.IssueLinks != 1 {
		t.Errorf("import result = %+v", result)
	}
	if len(result.UnresolvedIssues) != 1 || result.UnresolvedIssues[0] != "TES-404" {
		t.Errorf("unresolved_issues = %v, want [TES-404]", result.UnresolvedIssues)
	}

	board := getBoard(t, wsID)
	if board.Cockpit.Title != "AI+医药数据平台驾驶舱" {
		t.Errorf("title = %q", board.Cockpit.Title)
	}
	if len(board.Nodes) != 2 {
		t.Fatalf("nodes = %d, want 2 (the stale node should be gone)", len(board.Nodes))
	}
	byCode := map[string]CockpitNodeResponse{}
	for _, n := range board.Nodes {
		byCode[n.Code] = n
	}
	if _, stale := byCode["STALE-1"]; stale {
		t.Error("import left the previous board behind")
	}
	child, parent := byCode["L3-01-01"], byCode["L1-01"]
	if child.ParentID == nil || *child.ParentID != parent.ID {
		t.Errorf("parent wiring = %v, want %s", child.ParentID, parent.ID)
	}
	if len(board.Milestones) != 1 || board.Milestones[0].NodeID == nil || *board.Milestones[0].NodeID != parent.ID {
		t.Errorf("milestone = %+v", board.Milestones)
	}
}

// A rejected document must leave the previous board exactly as it was — a
// half-applied import is a tree with dangling parents.
func TestImportCockpitRollsBackOnBadDocument(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit import rollback")
	createNode(t, wsID, map[string]any{"code": "KEEP-1", "name": "still here"})

	testutil.Call(t, cockpitHandler(testHandler.ImportCockpit),
		cockpitRequest(http.MethodPut, "/api/cockpit/import", wsID, map[string]any{
			"nodes": []map[string]any{
				{"code": "A-1"},
				{"code": "A-2", "parent_code": "NOPE"},
			},
		})).
		Want(http.StatusBadRequest)

	board := getBoard(t, wsID)
	if len(board.Nodes) != 1 || board.Nodes[0].Code != "KEEP-1" {
		t.Errorf("nodes after rejected import = %+v", board.Nodes)
	}
}

func TestImportCockpitRequiresAdmin(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit import permission")
	dbfx.Exec(t, "UPDATE member SET role = 'member' WHERE workspace_id = $1 AND user_id = $2", wsID, testUserID)

	testutil.Call(t, cockpitHandler(testHandler.ImportCockpit),
		cockpitRequest(http.MethodPut, "/api/cockpit/import", wsID, map[string]any{"nodes": []map[string]any{}})).
		Want(http.StatusForbidden)

	// A plain member still edits the board — that is the whole point of a
	// shared planning surface.
	createNode(t, wsID, map[string]any{"code": "M-1"})
}

func TestCockpitRejectsNonMembers(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit membership")
	outsider := dbfx.User(t, "Outsider", "cockpit-outsider-"+uuid.NewString()+"@example.com")

	req := testutil.WithHeaders(
		testutil.JSONRequest(http.MethodGet, "/api/cockpit", nil),
		"X-User-ID", outsider,
		"X-Workspace-ID", wsID,
	)
	testutil.Call(t, cockpitHandler(testHandler.GetCockpit), req).
		WantOneOf(http.StatusNotFound, http.StatusForbidden)
}

// ---------------------------------------------------------------------------
// Version snapshots
// ---------------------------------------------------------------------------

func listSnapshots(t *testing.T, wsID string) []CockpitSnapshotResponse {
	t.Helper()
	var snaps []CockpitSnapshotResponse
	testutil.Call(t, cockpitHandler(testHandler.ListCockpitSnapshots),
		cockpitRequest(http.MethodGet, "/api/cockpit/snapshots", wsID, nil)).
		Want(http.StatusOK).
		JSON(&snaps)
	return snaps
}

func importBoard(t *testing.T, wsID string, body map[string]any) CockpitImportResponse {
	t.Helper()
	var result CockpitImportResponse
	testutil.Call(t, cockpitHandler(testHandler.ImportCockpit),
		cockpitRequest(http.MethodPut, "/api/cockpit/import", wsID, body)).
		Want(http.StatusOK).
		JSON(&result)
	return result
}

func importDoc(title, code string) map[string]any {
	return map[string]any{
		"title": title,
		"nodes": []map[string]any{{"code": code, "name": title}},
	}
}

func restoreSnapshot(t *testing.T, wsID, snapID string) *testutil.Response {
	t.Helper()
	return testutil.Call(t, cockpitHandler(testHandler.RestoreCockpitSnapshot),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPost, "/api/cockpit/snapshots/"+snapID+"/restore", wsID, nil),
			"snapshotId", snapID,
		))
}

// An import must freeze the board it displaces, and restoring that snapshot
// must put the displaced board back — including board-level fields the import
// document does not usually carry, such as the summary cards.
func TestCockpitSnapshotRestoreRoundTrip(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit snapshot round trip")
	dbfx.Issue(t, "Linked issue", testutil.Cols{"workspace_id": wsID})
	importBoard(t, wsID, map[string]any{
		"title": "v1 board",
		"nodes": []map[string]any{{
			"code": "L1-01", "name": "v1 module", "owner": "李青娇",
			"status": "进行中", "progress": 40,
			"issue_ids": []string{"TES-1"},
			"payments":  []map[string]any{{"label": "第1笔", "pay_date": "2026-09-05", "amount": 15}},
		}},
		"milestones": []map[string]any{{"name": "v1 milestone", "plan_date": "2026-11-30"}},
	})

	// An author card that the import document does not carry: restore must
	// bring it back, not wipe it.
	testutil.Call(t, cockpitHandler(testHandler.UpdateCockpit),
		cockpitRequest(http.MethodPatch, "/api/cockpit", wsID, map[string]any{
			"summary_overall": "本周完成数据治理",
		})).
		Want(http.StatusOK)

	importBoard(t, wsID, importDoc("v2 board", "L2-01"))

	board := getBoard(t, wsID)
	if board.Cockpit.Title != "v2 board" || len(board.Nodes) != 1 || board.Nodes[0].Code != "L2-01" {
		t.Fatalf("board after second import = %+v", board)
	}
	if board.Cockpit.SummaryOverall != "本周完成数据治理" {
		// A plain import has no summary keys, so the cards survive it.
		t.Fatalf("summary card did not survive a summary-less import: %q", board.Cockpit.SummaryOverall)
	}

	snaps := listSnapshots(t, wsID)
	if len(snaps) != 1 {
		t.Fatalf("snapshots = %d, want 1 (the v1 board the second import displaced)", len(snaps))
	}
	snap := snaps[0]
	if snap.TriggerKind != "import" || snap.NodeCount != 1 {
		t.Errorf("snapshot = %+v, want trigger=import node_count=1", snap)
	}
	if snap.CreatedByType != "member" || snap.CreatedByLabel == "" {
		t.Errorf("snapshot creator = %q/%q, want a named member", snap.CreatedByType, snap.CreatedByLabel)
	}

	var result CockpitImportResponse
	restoreSnapshot(t, wsID, snap.ID).Want(http.StatusOK).JSON(&result)
	if result.Nodes != 1 || result.IssueLinks != 1 || result.Payments != 1 || result.Milestones != 1 {
		t.Errorf("restore result = %+v", result)
	}

	board = getBoard(t, wsID)
	if board.Cockpit.Title != "v1 board" || len(board.Nodes) != 1 || board.Nodes[0].Code != "L1-01" {
		t.Fatalf("board after restore = %+v", board)
	}
	if board.Nodes[0].Status != "进行中" || board.Nodes[0].Progress != 40 {
		t.Errorf("restored node = %+v", board.Nodes[0])
	}
	if len(board.Payments) != 1 || len(board.IssueLinks) != 1 || len(board.Milestones) != 1 {
		t.Errorf("restored collections: payments=%d links=%d milestones=%d",
			len(board.Payments), len(board.IssueLinks), len(board.Milestones))
	}
	if board.Cockpit.SummaryOverall != "本周完成数据治理" {
		t.Errorf("summary card after restore = %q, want the frozen value", board.Cockpit.SummaryOverall)
	}

	// Restoring must itself freeze the board it displaces, so a restore is
	// always undoable.
	snaps = listSnapshots(t, wsID)
	if len(snaps) != 2 || snaps[0].TriggerKind != "restore" {
		t.Fatalf("snapshots after restore = %+v, want a restore-time snapshot of v2 newest", snaps)
	}
}

// A link to an issue that was deleted after the snapshot names it as an
// unresolvable reference on restore — reported, not fatal.
func TestCockpitRestoreSkipsDeletedIssue(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit restore deleted issue")
	issue := dbfx.Issue(t, "Doomed issue", testutil.Cols{"workspace_id": wsID})
	importBoard(t, wsID, map[string]any{
		"nodes": []map[string]any{{"code": "L1-01", "issue_ids": []string{issue}}},
	})

	// Freeze the board while the issue still exists. An import into the empty
	// board above froze nothing, so this manual save is the version under test.
	var frozen CockpitSnapshotResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitSnapshot),
		cockpitRequest(http.MethodPost, "/api/cockpit/snapshots", wsID, nil)).
		Want(http.StatusCreated).
		JSON(&frozen)

	dbfx.Exec(t, "DELETE FROM cockpit_node_issue WHERE issue_id = $1", issue)
	dbfx.Exec(t, "DELETE FROM issue WHERE id = $1", issue)
	importBoard(t, wsID, importDoc("replaced", "X-1"))

	var result CockpitImportResponse
	restoreSnapshot(t, wsID, frozen.ID).Want(http.StatusOK).JSON(&result)
	if len(result.UnresolvedIssues) != 1 || result.UnresolvedIssues[0] != issue {
		t.Errorf("unresolved_issues = %v, want the deleted issue's id", result.UnresolvedIssues)
	}
	board := getBoard(t, wsID)
	if len(board.Nodes) != 1 || len(board.IssueLinks) != 0 {
		t.Errorf("restored board: nodes=%d links=%d, want 1/0", len(board.Nodes), len(board.IssueLinks))
	}
}

// Importing into an empty board freezes nothing: there is no board to lose,
// and a snapshot of emptiness would bury real history.
func TestCockpitImportIntoEmptyBoardSnapshotsNothing(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit import empty")
	importBoard(t, wsID, importDoc("first", "L1-01"))
	if snaps := listSnapshots(t, wsID); len(snaps) != 0 {
		t.Errorf("snapshots = %d, want 0", len(snaps))
	}
}

func TestCreateCockpitSnapshotManual(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit manual snapshot")
	createNode(t, wsID, map[string]any{"code": "L1-01", "name": "module"})

	var snap CockpitSnapshotResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitSnapshot),
		cockpitRequest(http.MethodPost, "/api/cockpit/snapshots", wsID, map[string]any{
			"label": "评审前",
		})).
		Want(http.StatusCreated).
		JSON(&snap)
	if snap.TriggerKind != "manual" || snap.Label != "评审前" || snap.NodeCount != 1 {
		t.Errorf("manual snapshot = %+v", snap)
	}

	// An empty board has nothing worth freezing and is refused.
	empty := cockpitFixture(t, "Cockpit manual snapshot empty")
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitSnapshot),
		cockpitRequest(http.MethodPost, "/api/cockpit/snapshots", empty, nil)).
		Want(http.StatusBadRequest)
}

func TestCockpitSnapshotPermissions(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit snapshot permissions")
	createNode(t, wsID, map[string]any{"code": "L1-01"})
	var snap CockpitSnapshotResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitSnapshot),
		cockpitRequest(http.MethodPost, "/api/cockpit/snapshots", wsID, nil)).
		Want(http.StatusCreated).
		JSON(&snap)

	dbfx.Exec(t, "UPDATE member SET role = 'member' WHERE workspace_id = $1 AND user_id = $2", wsID, testUserID)

	// A plain member reads history and saves versions…
	listSnapshots(t, wsID)
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitSnapshot),
		cockpitRequest(http.MethodPost, "/api/cockpit/snapshots", wsID, nil)).
		Want(http.StatusCreated)

	// …but restore and delete stay with owner/admin, exactly like import.
	restoreSnapshot(t, wsID, snap.ID).Want(http.StatusForbidden)
	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitSnapshot),
		testutil.WithURLParams(
			cockpitRequest(http.MethodDelete, "/api/cockpit/snapshots/"+snap.ID, wsID, nil),
			"snapshotId", snap.ID,
		)).
		Want(http.StatusForbidden)

	dbfx.Exec(t, "UPDATE member SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2", wsID, testUserID)
	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitSnapshot),
		testutil.WithURLParams(
			cockpitRequest(http.MethodDelete, "/api/cockpit/snapshots/"+snap.ID, wsID, nil),
			"snapshotId", snap.ID,
		)).
		Want(http.StatusOK)
	if snaps := listSnapshots(t, wsID); len(snaps) != 1 {
		t.Errorf("snapshots after delete = %d, want 1", len(snaps))
	}
}

// Ordinary edits refresh version history rather than create it: the first
// entry stays deliberate, and once history exists an edit freezes at most one
// 'auto' checkpoint per interval, and only when the board actually moved.
func TestCockpitAutoSnapshotAfterSmallEdit(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit auto snapshot")
	importBoard(t, wsID, map[string]any{
		"nodes": []map[string]any{{"code": "L1-01", "name": "seed", "progress": 10}},
	})
	// A board with no history stays snapshot-free: importing into the empty
	// board froze nothing, and the first small edit must not mint history.
	setProgress := func(v float64) {
		t.Helper()
		var node CockpitNodeResponse
		testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitNode),
			testutil.WithURLParams(
				cockpitRequest(http.MethodPatch, "/api/cockpit/nodes/L1-01", wsID, map[string]any{"progress": v}),
				"id", "L1-01",
			)).
			Want(http.StatusOK).
			JSON(&node)
	}
	setProgress(15)
	if snaps := listSnapshots(t, wsID); len(snaps) != 0 {
		t.Fatalf("snapshots = %d, want 0 (no history yet, nothing automatic)", len(snaps))
	}

	// History is seeded deliberately; push it past the interval.
	var seeded CockpitSnapshotResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitSnapshot),
		cockpitRequest(http.MethodPost, "/api/cockpit/snapshots", wsID, nil)).
		Want(http.StatusCreated).
		JSON(&seeded)
	dbfx.Exec(t, "UPDATE cockpit_snapshot SET created_at = created_at - interval '10 minutes' WHERE workspace_id = $1", wsID)

	// An edit past the interval checkpoints, with the editor on record.
	setProgress(20)
	snaps := listSnapshots(t, wsID)
	if len(snaps) != 2 || snaps[0].TriggerKind != "auto" {
		t.Fatalf("snapshots = %+v, want an auto checkpoint newest above the manual seed", snaps)
	}
	if snaps[0].CreatedByType != "member" || snaps[0].CreatedByLabel == "" {
		t.Errorf("auto snapshot actor = %q/%q", snaps[0].CreatedByType, snaps[0].CreatedByLabel)
	}

	// The very next edit is inside the interval and throttled — even though
	// its value repeats, the interval check decides first.
	setProgress(20)
	if snaps := listSnapshots(t, wsID); len(snaps) != 2 {
		t.Fatalf("snapshots = %d, want 2 (interval throttles the next edit)", len(snaps))
	}

	// Past the interval again, a no-op edit (content equal to the newest
	// snapshot) mints nothing: the checkpoint did not fall behind.
	dbfx.Exec(t, "UPDATE cockpit_snapshot SET created_at = created_at - interval '10 minutes' WHERE workspace_id = $1", wsID)
	setProgress(20)
	if snaps := listSnapshots(t, wsID); len(snaps) != 2 {
		t.Fatalf("snapshots = %d, want 2 (a no-op edit is deduped)", len(snaps))
	}

	// A real edit checkpoints again.
	setProgress(30)
	snaps = listSnapshots(t, wsID)
	if len(snaps) != 3 || snaps[0].TriggerKind != "auto" {
		t.Fatalf("snapshots = %+v, want a fresh auto checkpoint newest", snaps)
	}
}

// Retention is bounded: snapshots accumulate automatically on every import
// and restore, so the oldest beyond the keep window must fall away.
func TestCockpitSnapshotPrune(t *testing.T) {
	wsID := cockpitFixture(t, "Cockpit snapshot prune")
	createNode(t, wsID, map[string]any{"code": "L1-01"})

	var boardID string
	dbfx.QueryRow(t, "SELECT id FROM cockpit WHERE workspace_id = $1", wsID).Scan(&boardID)
	for i := 0; i < cockpitSnapshotKeep+5; i++ {
		dbfx.Insert(t, "cockpit_snapshot", testutil.Cols{
			"workspace_id":    wsID,
			"cockpit_id":      boardID,
			"trigger_kind":    "manual",
			"payload":         `{"nodes":[]}`,
			"node_count":      0,
			"created_by_type": "member",
			// Distinct timestamps, oldest first, so the keep window has a
			// definite boundary to prune against.
			"created_at": time.Now().Add(-time.Duration(cockpitSnapshotKeep+10-i) * time.Minute),
		})
	}

	// Any snapshot write prunes; a manual one is the cheapest to drive.
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitSnapshot),
		cockpitRequest(http.MethodPost, "/api/cockpit/snapshots", wsID, nil)).
		Want(http.StatusCreated)

	snaps := listSnapshots(t, wsID)
	if len(snaps) != cockpitSnapshotKeep {
		t.Fatalf("snapshots = %d, want %d", len(snaps), cockpitSnapshotKeep)
	}
	// The newest surviving row is the one this test just wrote.
	if snaps[0].TriggerKind != "manual" || snaps[0].NodeCount != 1 {
		t.Errorf("newest snapshot = %+v, want the manual save of the live board", snaps[0])
	}
}
