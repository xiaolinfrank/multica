package handler

import (
	"fmt"
	"net/http"
	"testing"

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
