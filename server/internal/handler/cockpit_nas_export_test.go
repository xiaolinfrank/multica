package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func nasHTTPFixture(t *testing.T, modes ...string) (string, CockpitMeetingResponse, *cockpitnas.Files, string, string, CockpitMeetingWorkflowResponse) {
	t.Helper()
	ws, meeting := newCockpitWorkflowHTTPFixture(t)
	root, rootID := t.TempDir(), uuid.NewString()
	directory := filepath.Join(root, "meeting")
	if err := os.Mkdir(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, cockpitnas.MarkerName), []byte(rootID), 0o600); err != nil {
		t.Fatal(err)
	}
	mode := ""
	if len(modes) > 0 {
		mode = modes[0]
	}
	config, _ := json.Marshal([]cockpitnas.Root{{WorkspaceID: ws, RootID: rootID, Path: root, AllowLocal: true, WriteMode: mode}})
	files, err := cockpitnas.New(string(config))
	if err != nil {
		t.Fatal(err)
	}
	previous := testHandler.IssueService.CockpitNASExporter
	testHandler.IssueService.CockpitNASExporter = files
	t.Cleanup(func() { testHandler.IssueService.CockpitNASExporter = previous })
	testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitMeeting), testutil.WithURLParams(cockpitRequest(http.MethodPatch, "/meeting", ws,
		map[string]any{"nas_dir": directory}), "meetingId", meeting.ID)).Want(http.StatusOK)
	var state CockpitMeetingWorkflowResponse
	callCockpitWorkflow(t, testHandler.EnableCockpitMeetingWorkflow, http.MethodPost, ws, meeting.ID, "", "", map[string]any{"reviewer_id": testUserID}).Want(http.StatusOK).JSON(&state)
	callCockpitWorkflow(t, testHandler.UpdateCockpitMeetingReadiness, http.MethodPatch, ws, meeting.ID, "", "", map[string]any{"expected_revision": state.Revision, "ended": true, "materials_ready": true}).Want(http.StatusOK).JSON(&state)
	callCockpitWorkflow(t, testHandler.ReleaseCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", "", map[string]any{"expected_revision": state.Revision}).Want(http.StatusOK).JSON(&state)
	callCockpitWorkflow(t, testHandler.SubmitCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", "", map[string]any{"expected_revision": state.Revision, "submission_key": uuid.NewString(), "content": "# Accepted evidence\n\nThe approved text is fixed."}).Want(http.StatusOK).JSON(&state)
	callCockpitWorkflow(t, testHandler.ReviewCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", state.Versions[0].ID, map[string]any{"expected_revision": state.Revision, "decision": "approved"}).Want(http.StatusOK).JSON(&state)
	return ws, meeting, files, rootID, directory, state
}

func TestCockpitNASExportHTTPPublicationOfflineAndFrozenRetry(t *testing.T) {
	ws, meeting, files, rootID, directory, state := nasHTTPFixture(t)
	versionID, contentHash := state.Versions[0].ID, state.Versions[0].ContentHash
	if state.NASDestination == nil || state.NASDestination.Directory != directory || state.NASDestination.RootID != rootID || state.CanExportNAS {
		t.Fatalf("invalid unpublished destination read: %+v", state)
	}
	// The configuration remains valid while the physical directory is offline.
	if err := os.Rename(directory, directory+"-offline"); err != nil {
		t.Fatal(err)
	}
	command := map[string]any{"expected_revision": state.Revision, "nas_export": map[string]any{"root_id": rootID, "directory": directory}}
	callCockpitWorkflow(t, testHandler.PublishCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", versionID, command).Want(http.StatusOK).JSON(&state)
	callCockpitWorkflow(t, testHandler.PublishCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", versionID, command).Want(http.StatusOK).JSON(&state)
	if state.PublishedVersionID == nil || *state.PublishedVersionID != versionID || len(state.NASExports) != 1 || !state.CanExportNAS {
		t.Fatal("offline NAS blocked publication or duplicated intent")
	}
	exportID, target := state.NASExports[0].ID, state.NASExports[0].TargetPath
	worker := service.NewCockpitMinutesExportWorker(testHandler.Queries, files, nil)
	if worked, err := worker.ProcessNext(context.Background()); err != nil || !worked {
		t.Fatalf("worker: %v, %v", worked, err)
	}
	callCockpitWorkflow(t, testHandler.GetCockpitMeetingWorkflow, http.MethodGet, ws, meeting.ID, "", "", nil).Want(http.StatusOK).JSON(&state)
	if state.NASExports[0].Status != "retry_wait" || !state.NASExports[0].CanRetry || state.NASExports[0].LastErrorCode == "" || state.PublishedVersionID == nil {
		t.Fatalf("offline result lost its publication or recovery state: %+v", state.NASExports)
	}
	newDirectory := filepath.Join(filepath.Dir(directory), "future-location")
	testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitMeeting), testutil.WithURLParams(cockpitRequest(http.MethodPatch, "/meeting", ws,
		map[string]any{"nas_dir": newDirectory}), "meetingId", meeting.ID)).Want(http.StatusOK)
	if err := os.Rename(directory+"-offline", directory); err != nil {
		t.Fatal(err)
	}
	req := testutil.WithURLParams(cockpitRequest(http.MethodPost, "/retry", ws, map[string]any{"expected_revision": state.NASExports[0].Revision}), "meetingId", meeting.ID, "exportId", exportID)
	testutil.Call(t, cockpitHandler(testHandler.RetryCockpitMinutesExport), req).Want(http.StatusOK).JSON(&state)
	if state.NASExports[0].TargetPath != target || state.NASDestination.Directory != newDirectory {
		t.Fatal("retry silently adopted the new meeting directory")
	}
	if worked, err := worker.ProcessNext(context.Background()); err != nil || !worked {
		t.Fatalf("recovery worker: %v, %v", worked, err)
	}
	callCockpitWorkflow(t, testHandler.GetCockpitMeetingWorkflow, http.MethodGet, ws, meeting.ID, "", "", nil).Want(http.StatusOK).JSON(&state)
	if len(state.NASExports) != 1 || state.NASExports[0].ID != exportID || state.NASExports[0].Status != "succeeded" || state.NASExports[0].CanRetry || state.NASExports[0].ContentHash != contentHash || state.NASExports[0].SizeBytes == nil {
		t.Fatalf("missing fixed success receipt: %+v", state.NASExports)
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != state.Versions[0].Content {
		t.Fatalf("wrong exported bytes: %v", err)
	}
	// Workspace deletion removes the ledger without deleting team-owned files.
	testutil.Call(t, testHandler.DeleteWorkspace, testutil.WithURLParams(cockpitRequest(http.MethodDelete, "/workspace", ws, nil), "id", ws)).Want(http.StatusNoContent)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_minutes_export WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("export ledger outlived workspace deletion")
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatal("workspace deletion removed the NAS copy")
	}
}

func TestCockpitNASExportHTTPGuardsAndExplicitExport(t *testing.T) {
	ws, meeting, _, rootID, directory, state := nasHTTPFixture(t)
	version := state.Versions[0].ID
	callCockpitWorkflow(t, testHandler.PublishCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", version, map[string]any{"expected_revision": state.Revision}).Want(http.StatusOK).JSON(&state)
	if len(state.NASExports) != 0 {
		t.Fatal("ordinary publication requested an unselected external side effect")
	}
	outsider := dbfx.User(t, "Other member", "nas-member-"+uuid.NewString()+"@example.com")
	dbfx.Member(t, ws, outsider, "member")
	body := map[string]any{"root_id": rootID, "directory": directory}
	callCockpitWorkflow(t, testHandler.ExportCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, outsider, version, body).Want(http.StatusForbidden)
	callCockpitWorkflow(t, testHandler.ExportCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", version, map[string]any{"root_id": "invalid", "directory": directory}).Want(http.StatusBadRequest)
	callCockpitWorkflow(t, testHandler.ExportCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", version, body).Want(http.StatusOK).JSON(&state)
	callCockpitWorkflow(t, testHandler.ExportCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", version, body).Want(http.StatusOK).JSON(&state)
	if len(state.NASExports) != 1 {
		t.Fatal("repeated explicit export duplicated the intent")
	}
	callCockpitWorkflow(t, testHandler.GetCockpitMeetingWorkflow, http.MethodGet, ws, meeting.ID, outsider, "", nil).Want(http.StatusOK).JSON(&state)
	if state.CanExportNAS || state.NASExports[0].CanRetry {
		t.Fatal("ordinary member received export control capability")
	}
}
