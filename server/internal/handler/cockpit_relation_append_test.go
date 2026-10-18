package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestCockpitReferenceEnvelopeInvalidatesInstalledClientsWithoutPretendingAFullSet(t *testing.T) {
	receipt := CockpitMeetingIssueLinkReceipt{WorkspaceID: "ws", MeetingID: "meeting", Link: CockpitMeetingIssueResponse{MeetingID: "meeting", IssueID: "issue"}}
	body, err := json.Marshal(cockpitReferenceEventPayload("meeting_issues", receipt))
	if err != nil {
		t.Fatal(err)
	}
	var frame map[string]json.RawMessage
	if err := json.Unmarshal(body, &frame); err != nil {
		t.Fatal(err)
	}
	if string(frame["scope"]) != `"board"` || string(frame["action"]) != `"reference_changed"` || strings.Contains(string(body), `"links":`) {
		t.Fatalf("installed clients need a board refresh, never a partial links array: %s", body)
	}
}

func TestCockpitReferenceCompactRolesAcknowledgeOnlyTheSelectedLink(t *testing.T) {
	ws, meeting := newCockpitWorkflowHTTPFixture(t)
	var state CockpitMeetingWorkflowResponse
	callCockpitWorkflow(t, testHandler.EnableCockpitMeetingWorkflow, "POST", ws, meeting.ID, "", "", map[string]any{"reviewer_id": testUserID}).Want(200).JSON(&state)
	for i := 0; i < 30; i++ {
		id := dbfx.Issue(t, fmt.Sprintf("Other reference %d", i), testutil.Cols{"workspace_id": ws})
		dbfx.Exec(t, "INSERT INTO cockpit_meeting_issue(workspace_id,meeting_id,issue_id) VALUES($1,$2,$3)", ws, meeting.ID, id)
	}
	call := func(roles []string, response string) *testutil.Response {
		return testutil.Call(t, cockpitHandler(testHandler.SetCockpitMeetingIssueRoles), testutil.WithURLParams(
			cockpitRequest("PUT", "/roles?response="+response, ws, map[string]any{"roles": roles}), "meetingId", meeting.ID, "issueId", state.MinutesIssue.ID))
	}
	var result CockpitMeetingIssueLinkReceipt
	resp := call([]string{"preparation", "minutes"}, "compact").Want(200).JSON(&result)
	if result.WorkspaceID != ws || result.MeetingID != meeting.ID || result.Link.IssueID != state.MinutesIssue.ID || !slices.Equal(result.Link.Roles, []string{"minutes", "preparation"}) || !slices.Contains(result.Link.RequiredRoles, "minutes") || strings.Contains(resp.Text(), `"links":`) || len(resp.Text()) > 1500 {
		t.Fatalf("compact purpose receipt lost fixed relation identity: %s", resp.Text())
	}
	call([]string{"preparation"}, "compact").Want(409)
	call([]string{"minutes"}, "unknown").Want(400)
	var legacy meetingLinksResponse
	call([]string{"minutes"}, "").Want(200).JSON(&legacy)
	if len(legacy.Links) != 31 {
		t.Fatalf("legacy response changed: %d", len(legacy.Links))
	}
}

func callReferenceAppend(t *testing.T, fn http.HandlerFunc, ws, ownerParam, owner string, body any) *testutil.Response {
	t.Helper()
	return testutil.Call(t, cockpitHandler(fn), testutil.WithURLParams(cockpitRequest("POST", "/reference", ws, body), ownerParam, owner))
}

func TestCockpitReferenceAppendKeepsUnloadedLinksAndReturnsOneReceipt(t *testing.T) {
	ws := cockpitMeetingFixture(t, "Bounded reference append")
	node := createNode(t, ws, map[string]any{"code": "reference-target", "name": "Reference target"})
	meeting := createMeeting(t, ws, map[string]any{"title": "Bounded references"})
	for i := 0; i < 125; i++ {
		issue := dbfx.Issue(t, fmt.Sprintf("Unloaded %03d", i), testutil.Cols{"workspace_id": ws})
		dbfx.Exec(t, "INSERT INTO cockpit_node_issue(workspace_id,node_id,issue_id,position) VALUES($1,$2,$3,$4)", ws, node.ID, issue, i+10)
		dbfx.Exec(t, "INSERT INTO cockpit_meeting_issue(workspace_id,meeting_id,issue_id,roles,position) VALUES($1,$2,$3,ARRAY['preparation'], $4)", ws, meeting.ID, issue, i+10)
	}
	issue := dbfx.Issue(t, "One appended reference", testutil.Cols{"workspace_id": ws})
	issueCount := dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", ws)
	snapshots := dbfx.Count(t, "SELECT count(*) FROM cockpit_snapshot WHERE workspace_id=$1", ws)
	var nodeReceipt CockpitNodeIssueLinkReceipt
	response := callReferenceAppend(t, testHandler.AppendCockpitNodeIssue, ws, "id", node.Code, map[string]any{"issue_id": issue}).Want(200).JSON(&nodeReceipt)
	if nodeReceipt.WorkspaceID != ws || nodeReceipt.NodeID != node.ID || nodeReceipt.Link.IssueID != issue || strings.Contains(response.Text(), `"links":`) || len(response.Text()) > 1500 {
		t.Fatalf("append did not acknowledge one scoped link: %s", response.Text())
	}
	dbfx.Exec(t, "UPDATE cockpit_node_issue SET position=77 WHERE node_id=$1 AND issue_id=$2", node.ID, issue)
	callReferenceAppend(t, testHandler.AppendCockpitNodeIssue, ws, "id", node.ID, map[string]any{"issue_id": nodeReceipt.Link.IssueIdentifier}).Want(200).JSON(&nodeReceipt)
	if nodeReceipt.Link.Position != 77 || dbfx.Count(t, "SELECT count(*) FROM cockpit_node_issue WHERE node_id=$1", node.ID) != 126 {
		t.Fatal("repeat append reordered a reference or replaced an unloaded page")
	}
	var meetingReceipt CockpitMeetingIssueLinkReceipt
	callReferenceAppend(t, testHandler.AppendCockpitMeetingIssue, ws, "meetingId", meeting.ID, map[string]any{"issue_id": issue}).Want(200).JSON(&meetingReceipt)
	dbfx.Exec(t, "UPDATE cockpit_meeting_issue SET roles=ARRAY['preparation'],position=88 WHERE meeting_id=$1 AND issue_id=$2", meeting.ID, issue)
	callReferenceAppend(t, testHandler.AppendCockpitMeetingIssue, ws, "meetingId", meeting.ID, map[string]any{"issue_id": nodeReceipt.Link.IssueIdentifier}).Want(200).JSON(&meetingReceipt)
	if meetingReceipt.WorkspaceID != ws || meetingReceipt.Link.Position != 88 || !slices.Equal(meetingReceipt.Link.Roles, []string{"preparation"}) || dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_issue WHERE meeting_id=$1", meeting.ID) != 126 {
		t.Fatalf("repeat append lost role, position or unloaded relations: %+v", meetingReceipt)
	}
	var nodeMeetingReceipt CockpitMeetingNodeLinkReceipt
	callReferenceAppend(t, testHandler.AppendCockpitMeetingNode, ws, "meetingId", meeting.ID, map[string]any{"node_id": node.Code}).Want(200).JSON(&nodeMeetingReceipt)
	dbfx.Exec(t, "UPDATE cockpit_meeting_node SET position=99 WHERE meeting_id=$1 AND node_id=$2", meeting.ID, node.ID)
	callReferenceAppend(t, testHandler.AppendCockpitMeetingNode, ws, "meetingId", meeting.ID, map[string]any{"node_id": node.ID}).Want(200).JSON(&nodeMeetingReceipt)
	if nodeMeetingReceipt.WorkspaceID != ws || nodeMeetingReceipt.Link.NodeID != node.ID || nodeMeetingReceipt.Link.Position != 99 {
		t.Fatalf("node reference did not preserve identity: %+v", nodeMeetingReceipt)
	}
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_snapshot WHERE workspace_id=$1", ws) != snapshots {
		t.Fatal("bounded POST unexpectedly serialized a whole-board snapshot")
	}
	setMeetingIssues(t, ws, meeting.ID, map[string]any{"issue_ids": []string{issue}, "replace": false}).Want(200)
	setMeetingNodes(t, ws, meeting.ID, map[string]any{"node_ids": []string{node.ID}, "replace": false}).Want(200)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_issue WHERE meeting_id=$1 AND issue_id=$2 AND roles=ARRAY['preparation'] AND position=88", meeting.ID, issue) != 1 {
		t.Fatal("legacy append downgraded existing roles")
	}
	if dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", ws) != issueCount || dbfx.Count(t, "SELECT count(*) FROM cockpit_issue_primary WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("a reference created or reassigned execution work")
	}
}

func TestCockpitReferenceAppendPreservesWorkflowRolesAndRejectsOtherScopes(t *testing.T) {
	ws, meeting := newCockpitWorkflowHTTPFixture(t)
	var state CockpitMeetingWorkflowResponse
	callCockpitWorkflow(t, testHandler.EnableCockpitMeetingWorkflow, "POST", ws, meeting.ID, "", "", map[string]any{"reviewer_id": testUserID}).Want(200).JSON(&state)
	var receipt CockpitMeetingIssueLinkReceipt
	callReferenceAppend(t, testHandler.AppendCockpitMeetingIssue, ws, "meetingId", meeting.ID, map[string]any{"issue_id": state.MinutesIssue.ID}).Want(200).JSON(&receipt)
	if !slices.Contains(receipt.Link.RequiredRoles, "minutes") || !slices.Contains(receipt.Link.Roles, "minutes") {
		t.Fatalf("append hid required workflow purpose: %+v", receipt)
	}
	foreign := cockpitMeetingFixture(t, "Other reference scope")
	foreignIssue := dbfx.Issue(t, "Foreign", testutil.Cols{"workspace_id": foreign})
	foreignNode := createNode(t, foreign, map[string]any{"code": "foreign"})
	callReferenceAppend(t, testHandler.AppendCockpitMeetingIssue, ws, "meetingId", meeting.ID, map[string]any{"issue_id": foreignIssue}).Want(400)
	callReferenceAppend(t, testHandler.AppendCockpitMeetingNode, ws, "meetingId", meeting.ID, map[string]any{"node_id": foreignNode.ID}).Want(400)
	callReferenceAppend(t, testHandler.AppendCockpitMeetingIssue, foreign, "meetingId", meeting.ID, map[string]any{"issue_id": foreignIssue}).Want(404)
	empty := cockpitFixture(t, "No board must be created")
	callReferenceAppend(t, testHandler.AppendCockpitNodeIssue, empty, "id", uuid.NewString(), map[string]any{"issue_id": foreignIssue}).Want(404)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1", empty) != 0 {
		t.Fatal("invalid append created a board")
	}
}
