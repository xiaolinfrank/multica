package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func directoryHTTPHandler(t *testing.T, ws, root string, allowed bool) (*Handler, string) {
	t.Helper()
	h := *testHandler
	s := *h.IssueService
	s.CockpitMeetingDirectoryBackendReady = true
	h.IssueService = &s
	id := uuid.NewString()
	cfg := cockpitnas.Root{WorkspaceID: ws, RootID: id, Path: root, AllowLocal: true, WriteMode: cockpitnas.ModeCreateOnly}
	if allowed {
		cfg.PrepareSubpaths = []string{"."}
	}
	raw, err := json.Marshal([]cockpitnas.Root{cfg})
	if err != nil {
		t.Fatal(err)
	}
	files, err := cockpitnas.New(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	s.CockpitDirectoryPreparer = files
	if err = os.WriteFile(filepath.Join(root, cockpitnas.MarkerName), []byte(id+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"cockpit_meeting_lifecycle_command", "cockpit_meeting_directory_operation", "cockpit_meeting_directory_step", "cockpit_meeting_directory_attempt", "search_index_change"} {
		dbfx.Cleanup(t, "DELETE FROM "+table+" WHERE workspace_id=$1", ws)
	}
	return &h, id
}
func TestCockpitDirectoryHTTPUnavailableDoesNotInitialize(t *testing.T) {
	h := &Handler{}
	for _, fn := range []http.HandlerFunc{h.ListCockpitDirectoryRoots, h.GetCockpitMeetingDirectory, h.CreateCockpitMeetingDirectory, h.ControlCockpitDirectoryOperation} {
		rec := httptest.NewRecorder()
		fn(rec, httptest.NewRequest("GET", "/directory", nil))
		if rec.Code != 503 {
			t.Fatalf("missing runtime status=%d", rec.Code)
		}
	}
}
func TestCockpitDirectoryHTTPReadsStayScopedAndDoNotProbeFilesystem(t *testing.T) {
	ws, m := lifecycleHTTPFixture(t)
	root := t.TempDir()
	h, rid := directoryHTTPHandler(t, ws, root, true)
	// Root metadata must remain readable without touching a disconnected path.
	if err := os.Remove(filepath.Join(root, cockpitnas.MarkerName)); err != nil {
		t.Fatal(err)
	}
	var roots service.CockpitDirectoryRootPage
	preparationCall(t, h.ListCockpitDirectoryRoots, "GET", "/directory-roots?page_size=25", ws, nil).Want(200).JSON(&roots)
	if len(roots.Items) != 1 || roots.Items[0].RootID != rid || roots.NextCursor != nil || roots.Total != 1 {
		t.Fatalf("root page %+v", roots)
	}
	emptyWorkspace := dbfx.Workspace(t, "Directory discovery", "directory-discovery-"+uuid.NewString())
	dbfx.Member(t, emptyWorkspace, testUserID, "member")
	preparationCall(t, h.ListCockpitDirectoryRoots, "GET", "/directory-roots", emptyWorkspace, nil).Want(200).JSON(&roots)
	if roots.Total != 0 || len(roots.Items) != 0 || dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1", emptyWorkspace) != 0 {
		t.Fatal("root discovery initialized a board or exposed another workspace's root")
	}
	preparationCall(t, h.ListCockpitDirectoryRoots, "GET", "/directory-roots?project_id="+uuid.NewString(), ws, nil).Want(400)
	preparationCall(t, h.ListCockpitDirectoryRoots, "GET", "/directory-roots?page_size=25&page_size=1", ws, nil).Want(400)
	preparationCall(t, h.ListCockpitDirectoryRoots, "GET", "/directory-roots?page_size=101", ws, nil).Want(400)
	var summary service.CockpitDirectorySummary
	preparationCall(t, h.GetCockpitMeetingDirectory, "GET", "/directory", ws, nil, "meetingId", m.ID).Want(200).JSON(&summary)
	if summary.WorkspaceID != ws || summary.MeetingID != m.ID || summary.Current != nil || summary.HistoryTotal != 0 {
		t.Fatalf("empty meeting summary %+v", summary)
	}
	other, _ := lifecycleHTTPFixture(t)
	preparationCall(t, h.GetCockpitMeetingDirectory, "GET", "/directory", other, nil, "meetingId", m.ID).Want(404)
	preparationCall(t, h.GetCockpitDirectoryRoot, "GET", "/root", other, nil, "rootId", rid).Want(404)
	for _, source := range []string{"task_token", "cloud_pat"} {
		req := testutil.WithURLParams(cockpitRequest("GET", "/directory", ws, nil), "meetingId", m.ID)
		req.Header.Set("X-Actor-Source", source)
		req.Header.Set("X-Task-Token-ID", uuid.NewString())
		req.Header.Set("X-Agent-ID", uuid.NewString())
		req.Header.Set("X-Task-ID", uuid.NewString())
		want := 403
		if source == "cloud_pat" {
			want = 200
		}
		testutil.Call(t, cockpitHandler(h.GetCockpitMeetingDirectory), req).Want(want)
		testutil.Call(t, cockpitHandler(h.ListCockpitDirectoryRoots), req).Want(403)
	}
	if entries, err := os.ReadDir(root); err != nil || len(entries) != 0 {
		t.Fatal("metadata reads wrote filesystem")
	}
}
func TestCockpitDirectoryHTTPCommandsKeepExactOriginalReceipt(t *testing.T) {
	ws, m := lifecycleHTTPFixture(t)
	root := t.TempDir()
	h, rid := directoryHTTPHandler(t, ws, root, true)
	input := service.CockpitDirectoryPreviewInput{Mode: "prepare", RootID: rid, RelativeDirectory: "fixed-meeting", Partitions: []string{"materials"}, ObservedNASDir: "", ObservedBindingRevision: 1, BindAfterBase: true}
	var preview service.CockpitDirectoryPreview
	preparationCall(t, h.PreviewCockpitMeetingDirectory, "POST", "/preview", ws, input, "meetingId", m.ID).Want(200).JSON(&preview)
	if !preview.CanConfirm || preview.ContextToken == "" || len(preview.Steps) != 2 {
		t.Fatalf("preview %+v", preview)
	}
	body := service.CockpitDirectoryCreateInput{CockpitDirectoryPreviewInput: input, CommandKey: uuid.NewString(), ExpectedRevision: 1, ContextToken: preview.ContextToken}
	var made service.CockpitDirectoryCommandResult
	preparationCall(t, h.CreateCockpitMeetingDirectory, "POST", "/directory", ws, body, "meetingId", m.ID).Want(200).JSON(&made)
	if made.Receipt.Target != preview.Target || made.Receipt.PlanHash != preview.PlanHash || made.Receipt.Principal.Source != "human" || made.Receipt.Principal.ConfirmedByUserID == nil || made.Current.ID != made.Receipt.DirectoryOperationID {
		t.Fatalf("unconfirmed plan %+v", made)
	}
	if *made.Receipt.Principal.ConfirmedByUserID != testUserID || made.Receipt.Principal.ActorID != testUserID || made.Receipt.Principal.RunID != nil || made.Receipt.Principal.AgentID != nil {
		t.Fatal("human directory confirmation fabricated another principal or a Run")
	}
	if _, err := os.Stat(filepath.Join(root, "fixed-meeting")); !os.IsNotExist(err) {
		t.Fatal("registration executed filesystem work before the worker")
	}
	var replay service.CockpitDirectoryCommandResult
	preparationCall(t, h.CreateCockpitMeetingDirectory, "POST", "/directory", ws, body, "meetingId", m.ID).Want(200).JSON(&replay)
	if !replay.Replayed || replay.CommandKey != body.CommandKey || replay.Receipt.RequestHash != made.Receipt.RequestHash || replay.Current.ID != made.Current.ID {
		t.Fatal("same command created a second plan")
	}
	otherKey := body
	otherKey.CommandKey = uuid.NewString()
	var conflict map[string]any
	preparationCall(t, h.CreateCockpitMeetingDirectory, "POST", "/directory", ws, otherKey, "meetingId", m.ID).Want(409).JSON(&conflict)
	if conflict["code"] != "directory_operation_exists" || conflict["workspace_id"] != ws || conflict["meeting_id"] != m.ID || conflict["root_id"] != rid || conflict["directory_operation_id"] != made.Current.ID || conflict["command_key"] != otherKey.CommandKey {
		t.Fatalf("natural conflict did not identify this request and the existing plan: %+v", conflict)
	}
	var paused service.CockpitDirectoryCommandResult
	control := service.CockpitDirectoryControlInput{CommandKey: uuid.NewString(), ExpectedRevision: made.Current.Revision, Transition: "pause", Reason: "Wait for the confirmed folder review."}
	preparationCall(t, h.ControlCockpitDirectoryOperation, "POST", "/control", ws, control, "meetingId", m.ID, "operationId", made.Current.ID).Want(200).JSON(&paused)
	preparationCall(t, h.CreateCockpitMeetingDirectory, "POST", "/directory", ws, body, "meetingId", m.ID).Want(200).JSON(&replay)
	if replay.Current.State != "paused" || replay.Receipt.State != made.Receipt.State || replay.Receipt.OperationRevision != made.Receipt.OperationRevision {
		t.Fatal("current progress overwrote the fixed create receipt")
	}
	foreign, _ := lifecycleHTTPFixture(t)
	preparationCall(t, h.GetCockpitDirectoryOperation, "GET", "/operation", foreign, nil, "meetingId", m.ID, "operationId", made.Current.ID).Want(404)
	preparationCall(t, h.GetCockpitDirectoryOperation, "GET", "/operation", ws, nil, "meetingId", uuid.NewString(), "operationId", made.Current.ID).Want(404)
	malformed := map[string]any{"command_key": uuid.NewString(), "expected_revision": 1, "transition": "pause", "principal": map[string]string{"source": "human"}}
	preparationCall(t, h.ControlCockpitDirectoryOperation, "POST", "/control", ws, malformed, "meetingId", m.ID, "operationId", made.Current.ID).Want(400)
	for _, bad := range []string{`{`, strings.Repeat(" ", 64<<10) + `{}`} {
		req := testutil.WithURLParams(cockpitRequest("POST", "/control", ws, nil), "meetingId", m.ID, "operationId", made.Current.ID)
		req.Body = http.NoBody
		raw := httptest.NewRequest("POST", "/control", strings.NewReader(bad))
		req.Body = raw.Body
		testutil.Call(t, cockpitHandler(h.ControlCockpitDirectoryOperation), req).Want(400)
	}
	if dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", ws) != 0 || dbfx.Count(t, "SELECT count(*) FROM agent_task_queue q JOIN issue i ON i.id=q.issue_id WHERE i.workspace_id=$1", ws) != 0 {
		t.Fatal("directory command created work or execution")
	}
	preparationCall(t, h.DeleteCockpitMeeting, "DELETE", "/meeting", ws, nil, "meetingId", m.ID).Want(409)
	preparationCall(t, h.ImportCockpit, "PUT", "/import", ws, map[string]any{"nodes": []any{}}).Want(409)
	var retained service.CockpitDirectoryOperationHeader
	preparationCall(t, h.GetCockpitDirectoryOperation, "GET", "/operation", ws, nil, "meetingId", m.ID, "operationId", made.Current.ID).Want(200).JSON(&retained)
	if retained.ID != made.Current.ID || retained.State != "paused" {
		t.Fatal("blocked deletion or restore discarded the retained directory plan")
	}
}
func TestCockpitDirectoryHTTPLegacyMissingPermissionReportsImportedMeetingSeparately(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Explicit preparation permission", true)
	h, _ := directoryHTTPHandler(t, f.wsID, f.root, false)
	m := createMeeting(t, f.wsID, map[string]any{"title": "No implied root permission"})
	var out CockpitMeetingProvisionResponse
	preparationCall(t, h.ProvisionCockpitMeeting, "POST", "/provision", f.wsID, map[string]any{"create_task": false, "project_id": f.project, "module_id": f.module, "node_id": f.node}, "meetingId", m.ID).Want(200).JSON(&out)
	if out.DirCreated || out.DirError == "" || out.DirErrorCode != "prepare_not_configured" || out.DirectoryOperationID != "" {
		t.Fatalf("export/root presence silently authorized preparation: %+v", out)
	}
	name := "20261011-01 Already exists"
	path := filepath.Join(f.archiveDir, name)
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	var imported CockpitMeetingImportResponse
	preparationCall(t, h.ImportCockpitMeetingFolders, "POST", "/import", f.wsID, map[string]any{"project_id": f.project, "module_id": f.module, "node_id": f.node, "create_task": false, "items": []map[string]any{{"name": name, "title": "Existing folder"}}}).Want(200).JSON(&imported)
	if len(imported.Meetings) != 1 || len(imported.Skipped) != 0 || len(imported.DirectoryResults) != 1 {
		t.Fatalf("import and directory outcomes were conflated: %+v", imported)
	}
	result := imported.DirectoryResults[0]
	if result.MeetingID != imported.Meetings[0].ID || result.DirCreated || result.DirErrorCode != "prepare_not_configured" {
		t.Fatalf("unconfirmed imported directory: %+v", result)
	}
	if entries, err := os.ReadDir(path); err != nil || len(entries) != 0 {
		t.Fatal("legacy import bypassed the configured preparation scope")
	}
}

func TestCockpitDirectoryHTTPImportTaskFailureKeepsTheImportedMeeting(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Separate import task outcome", true)
	name := "20261011-02 Task recovery"
	path := filepath.Join(f.archiveDir, name)
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	h := *f.directoryHandler
	svc := *h.IssueService
	svc.TxStarter = meetingQueryFailureStarter{base: testHandler.TxStarter, name: "CreateCockpitMeetingIssue"}
	h.IssueService = &svc
	body := map[string]any{"project_id": f.project, "module_id": f.module, "node_id": f.node, "create_task": true, "items": []map[string]any{{"name": name, "title": "Imported once", "meet_date": "2026-10-11"}}}
	var out CockpitMeetingImportResponse
	preparationCall(t, h.ImportCockpitMeetingFolders, "POST", "/import", f.wsID, body).Want(200).JSON(&out)
	if len(out.Meetings) != 1 || len(out.Skipped) != 0 || len(out.TaskErrors) != 1 || len(out.Issues) != 0 {
		t.Fatalf("task failure hid the successful import: %+v", out)
	}
	if failure := out.TaskErrors[0]; failure.Name != name || failure.MeetingID != out.Meetings[0].ID || failure.Error == "" {
		t.Fatalf("task recovery lost exact meeting identity: %+v", failure)
	}
	if dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", f.wsID) != 0 {
		t.Fatal("failed task linking retained an orphan Issue")
	}
	var again CockpitMeetingImportResponse
	preparationCall(t, f.directoryHandler.ImportCockpitMeetingFolders, "POST", "/import", f.wsID, body).Want(200).JSON(&again)
	if len(again.Meetings) != 0 || len(again.Skipped) != 1 || len(again.TaskErrors) != 0 {
		t.Fatal("repeating import recreated a meeting or silently replayed the failed task")
	}
}
