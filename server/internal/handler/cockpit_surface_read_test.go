package handler

import (
	"net/http"
	"sync"
	"testing"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestCockpitSurfaceHTTPDoesNotInitializeAndRejectsInvalidScope(t *testing.T) {
	ws := cockpitMeetingFixture(t, "surface reads")
	var header service.CockpitSurfaceContext
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitSurfaceContext), cockpitRequest(http.MethodGet, "/api/cockpit/context", ws, nil)).Want(http.StatusOK).JSON(&header)
	if header.WorkspaceID != ws || header.Cockpit != nil || !header.Actor.IsHuman {
		t.Fatalf("read created a board or lost actor: %+v", header)
	}
	var code service.CockpitNodeCodePreview
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitNextNodeCode), cockpitRequest(http.MethodGet, "/api/cockpit/nodes/next-code", ws, nil)).Want(http.StatusOK).JSON(&code)
	if code.Code != "L1-01" || code.ParentID != nil {
		t.Fatalf("empty root preview: %+v", code)
	}
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitSurfaceContext), cockpitRequest(http.MethodGet, "/api/cockpit/context", ws, nil)).Want(http.StatusOK).JSON(&header)
	if header.Cockpit != nil {
		t.Fatal("code preview initialized a board")
	}
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitPlanSurface), cockpitRequest(http.MethodGet, "/api/cockpit/plan?module_id=not-a-uuid", ws, nil)).Want(http.StatusBadRequest)
	testutil.Call(t, cockpitHandler(testHandler.ListCockpitMeetingRegister), cockpitRequest(http.MethodGet, "/api/cockpit/meetings?only=unknown", ws, nil)).Want(http.StatusBadRequest)
}

func TestCockpitSurfaceConcurrentCreationDoesNotReservePreview(t *testing.T) {
	ws := cockpitMeetingFixture(t, "surface meeting sequence")
	getBoard(t, ws)
	var preview service.CockpitMeetingNextCode
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitMeetingNextCode), cockpitRequest(http.MethodGet, "/api/cockpit/meetings/next-code?date=2026-10-10", ws, nil)).Want(http.StatusOK).JSON(&preview)
	if preview.Code != "20261010-01" {
		t.Fatalf("unexpected initial preview: %+v", preview)
	}
	var wg sync.WaitGroup
	var codes sync.Map
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var meeting CockpitMeetingResponse
			testutil.Call(t, cockpitHandler(testHandler.CreateCockpitMeeting), cockpitRequest(http.MethodPost, "/api/cockpit/meetings", ws, map[string]any{"title": "Concurrent meeting", "meet_date": "2026-10-10"})).Want(http.StatusCreated).JSON(&meeting)
			if _, seen := codes.LoadOrStore(meeting.Code, true); seen {
				t.Errorf("concurrent creation reused code %s", meeting.Code)
			}
		}()
	}
	wg.Wait()
	var next service.CockpitMeetingNextCode
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitMeetingNextCode), cockpitRequest(http.MethodGet, "/api/cockpit/meetings/next-code?date=2026-10-10", ws, nil)).Want(http.StatusOK).JSON(&next)
	if next.Code != "20261010-05" {
		t.Fatalf("preview reserved a code or insert lost allocation: %+v", next)
	}
}

func TestCockpitSurfaceMeetingCreationCommitsAnchorOrNothing(t *testing.T) {
	ws := cockpitMeetingFixture(t, "atomic meeting scope")
	node := createNode(t, ws, map[string]any{"code": "L1-01", "name": "Meeting anchor"})
	var created CockpitMeetingCreateResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitMeeting), cockpitRequest(http.MethodPost, "/api/cockpit/meetings", ws, map[string]any{"title": "Anchored", "meet_date": "2026-10-10", "node_id": node.ID})).Want(http.StatusCreated).JSON(&created)
	if created.NodeLink == nil || created.NodeLink.NodeID != node.ID || created.NodeLink.MeetingID != created.ID {
		t.Fatalf("meeting creation did not acknowledge its atomic anchor: %+v", created)
	}
	board := getBoard(t, ws)
	if len(board.Meetings) != 1 || len(board.MeetingNodes) != 1 || board.MeetingNodes[0].MeetingID != created.ID {
		t.Fatalf("meeting and anchor must commit together: %+v", board)
	}
	foreign := cockpitMeetingFixture(t, "foreign meeting scope")
	foreignNode := createNode(t, foreign, map[string]any{"code": "L1-01"})
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitMeeting), cockpitRequest(http.MethodPost, "/api/cockpit/meetings", ws, map[string]any{"title": "Wrong scope", "meet_date": "2026-10-10", "node_id": foreignNode.ID})).Want(http.StatusNotFound)
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitMeeting), cockpitRequest(http.MethodPost, "/api/cockpit/meetings", ws, map[string]any{"title": "Bad ID", "node_id": "not-an-id"})).Want(http.StatusBadRequest)
	if got := getBoard(t, ws); len(got.Meetings) != 1 || len(got.MeetingNodes) != 1 {
		t.Fatal("failed anchor created an unfiled meeting")
	}
}

func TestCockpitSurfaceNewNodesAppendToExistingSiblings(t *testing.T) {
	ws := cockpitMeetingFixture(t, "append plan order")
	root := createNode(t, ws, map[string]any{"code": "L1-01", "position": 100})
	next := createNode(t, ws, map[string]any{"code": "L1-02"})
	child := createNode(t, ws, map[string]any{"code": "L1-01-01", "parent_id": root.ID, "position": 500})
	sibling := createNode(t, ws, map[string]any{"code": "L1-01-02", "parent_id": root.ID})
	if next.Position <= root.Position || sibling.Position <= child.Position {
		t.Fatalf("omitted position must append in its own siblings: root %v/%v child %v/%v", root.Position, next.Position, child.Position, sibling.Position)
	}
	var index service.CockpitNodeIndexPage
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitNodeIndex), cockpitRequest(http.MethodGet, "/api/cockpit/plan/node-index", ws, nil)).Want(http.StatusOK).JSON(&index)
	if index.WorkspaceID != ws || index.Total != 4 || len(index.Items) != 4 {
		t.Fatalf("standalone index lost stable plan identities: %+v", index)
	}
}
