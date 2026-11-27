package handler

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"

	"github.com/multica-ai/multica/server/internal/collabfs"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func issueDeliveryPath(t *testing.T, ws, issueID string) string {
	t.Helper()
	var detail struct {
		DeliveryPath *string `json:"delivery_path"`
	}
	testutil.Call(t, cockpitHandler(testHandler.GetIssue), testutil.WithURLParams(
		cockpitRequest(http.MethodGet, "/api/issues/x", ws, nil), "id", issueID)).Want(http.StatusOK).JSON(&detail)
	if detail.DeliveryPath == nil {
		return ""
	}
	return *detail.DeliveryPath
}

func ensureIssueFolder(t *testing.T, ws, issueID string) IssueDirectoryStatus {
	t.Helper()
	var status IssueDirectoryStatus
	testutil.Call(t, cockpitHandler(testHandler.EnsureIssueDirectory), testutil.WithURLParams(
		cockpitRequest(http.MethodPost, "/api/issues/x/directory/ensure", ws, nil), "id", issueID)).
		Want(http.StatusOK).JSON(&status)
	return status
}

// An issue owns no folder: it delivers into the folder it is filed under, so
// re-filing it moves nothing on disk, even while an agent is working.
func TestIssueDeliversIntoItsFilingFolder(t *testing.T) {
	collab := t.TempDir()
	ws, project := round2Plan(t, "Issue filing folder", collab)
	module := round2Module(t, ws, project, "确权线")
	item := round2WorkItem(t, ws, module.ID, "接口设计")
	itemDir := filepath.Join(collab, *module.DirectoryName, round2NodeDir(t, ws, item.ID))
	// A stored per-issue folder name is ignored.
	issueID := dbfx.Issue(t, "注册路径设计", testutil.Cols{
		"workspace_id": ws, "project_id": project, "module_id": module.ID, "work_item_id": item.ID,
		"directory_name": "TES-7注册路径设计",
	})
	if got := issueDeliveryPath(t, ws, issueID); got != itemDir {
		t.Fatalf("delivery path = %q, want %q", got, itemDir)
	}
	if status := ensureIssueFolder(t, ws, issueID); status.Status != "ok" || status.Source != "filing" || status.MeetingID != nil {
		t.Fatalf("ensure = %+v", status)
	}
	entries, err := os.ReadDir(itemDir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("the work item folder gained an issue folder: %v %v", entries, err)
	}

	agent := dbfx.Agent(t, "Filing agent", "", testutil.Cols{"workspace_id": ws})
	dbfx.Insert(t, "agent_task_queue", testutil.Cols{"agent_id": agent, "issue_id": issueID, "status": "running", "runtime_id": testRuntimeID})
	testutil.Call(t, cockpitHandler(testHandler.UpdateIssue), testutil.WithURLParams(
		cockpitRequest(http.MethodPut, "/api/issues/x", ws, map[string]any{"work_item_id": nil}), "id", issueID)).
		Want(http.StatusOK)
	if got, want := issueDeliveryPath(t, ws, issueID), filepath.Join(collab, *module.DirectoryName); got != want {
		t.Fatalf("delivery path after unfiling = %q, want %q", got, want)
	}
	if _, err := os.Stat(itemDir); err != nil {
		t.Fatalf("re-filing an issue touched the work item folder: %v", err)
	}
}

// Meeting work goes into the meeting's folder; follow-up links and ambiguous
// bindings stay with the filing.
func TestMeetingWorkDeliversIntoTheMeetingFolder(t *testing.T) {
	collab := t.TempDir()
	ws, project := round2Plan(t, "Issue meeting folder", collab)
	module := round2Module(t, ws, project, "确权线")
	moduleDir := filepath.Join(collab, *module.DirectoryName)
	meetingDir := filepath.Join(moduleDir, "20261127-01 周会")
	first := createMeeting(t, ws, map[string]any{"title": "周会", "nas_dir": meetingDir})
	second := createMeeting(t, ws, map[string]any{"title": "评审会", "nas_dir": filepath.Join(moduleDir, "20261127-02 评审会")})

	link := func(meetingID, issueID, role string, roles []string) {
		dbfx.Exec(t, `INSERT INTO cockpit_meeting_issue(workspace_id,meeting_id,issue_id,role,roles) VALUES($1,$2,$3,$4,$5)`,
			ws, meetingID, issueID, role, roles)
		dbfx.Cleanup(t, "DELETE FROM cockpit_meeting_issue WHERE workspace_id=$1 AND issue_id=$2", ws, issueID)
	}
	issue := func(title string) string {
		return dbfx.Issue(t, title, testutil.Cols{"workspace_id": ws, "project_id": project, "module_id": module.ID})
	}
	for name, tc := range map[string]struct {
		role  string
		roles []string
		want  string
	}{
		"provisioned task": {role: "task", roles: []string{}, want: meetingDir},
		"task role":        {roles: []string{"task"}, want: meetingDir},
		"preparation":      {roles: []string{"preparation"}, want: meetingDir},
		"support":          {roles: []string{"support"}, want: meetingDir},
		"minutes":          {roles: []string{"minutes"}, want: meetingDir},
		"review":           {roles: []string{"review"}, want: meetingDir},
		"action":           {roles: []string{"action"}, want: moduleDir},
		"plain link":       {roles: []string{}, want: moduleDir},
	} {
		id := issue(name)
		link(first.ID, id, tc.role, tc.roles)
		if got := issueDeliveryPath(t, ws, id); got != tc.want {
			t.Errorf("%s: delivery path = %q, want %q", name, got, tc.want)
		}
	}

	shared := issue("两场会议")
	link(first.ID, shared, "", []string{"preparation"})
	link(second.ID, shared, "", []string{"minutes"})
	if got := issueDeliveryPath(t, ws, shared); got != moduleDir {
		t.Errorf("shared by two folders: delivery path = %q, want %q", got, moduleDir)
	}

	// Opening a meeting folder reports it and names the meeting that prepares
	// it; the issue never creates it.
	minutes := issue("纪要")
	link(first.ID, minutes, "", []string{"minutes"})
	if status := ensureIssueFolder(t, ws, minutes); status.Status != "missing" || status.Source != "meeting" || status.MeetingID == nil || *status.MeetingID != first.ID {
		t.Fatalf("ensure on a missing meeting folder = %+v", status)
	}
	readStatus := func(issueID string) IssueDirectoryStatus {
		var read IssueDirectoryStatus
		testutil.Call(t, cockpitHandler(testHandler.GetIssueDirectory), testutil.WithURLParams(
			cockpitRequest(http.MethodGet, "/api/issues/x/directory", ws, nil), "id", issueID)).Want(http.StatusOK).JSON(&read)
		return read
	}
	if read := readStatus(minutes); read.Status != "missing" || read.Source != "meeting" || read.MeetingID == nil || *read.MeetingID != first.ID {
		t.Fatalf("status of a missing meeting folder = %+v", read)
	}

	// Meetings sharing one folder are one folder; the row points at the meeting
	// that can still prepare it, even when an archived one is older.
	archived := dbfx.Insert(t, "cockpit_meeting", testutil.Cols{
		"workspace_id": ws, "cockpit_id": uuid.NewString(), "title": "旧周会", "nas_dir": meetingDir,
		"created_at": "2020-01-01T00:00:00Z", "archived_at": "2020-01-02T00:00:00Z", "archived_by": uuid.NewString(), "archived_reason": "已归档",
	})
	sharedFolder := issue("共用目录")
	link(archived, sharedFolder, "", []string{"preparation"})
	link(first.ID, sharedFolder, "", []string{"preparation"})
	if read := readStatus(sharedFolder); read.FullPath == nil || *read.FullPath != meetingDir || read.MeetingID == nil || *read.MeetingID != first.ID {
		t.Fatalf("status of a folder shared with an archived meeting = %+v", read)
	}
	if code, _ := collabfs.StatDir(collab, *module.DirectoryName, "20261127-01 周会"); code != collabfs.StatMissing {
		t.Fatalf("ensure created the meeting folder: %s", code)
	}
	if err := os.Mkdir(meetingDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if status := ensureIssueFolder(t, ws, minutes); status.Status != "ok" {
		t.Fatalf("ensure on an existing meeting folder = %+v", status)
	}
}

// A claim names the delivery folder and where it comes from without touching
// the disk: the meeting's folder for meeting work, the filing folder otherwise,
// and none for a project without a collaboration space.
func TestClaimNamesTheDeliveryDirectory(t *testing.T) {
	collab := t.TempDir()
	var agentID string
	if err := testPool.QueryRow(context.Background(), `SELECT id::text FROM agent WHERE workspace_id=$1 LIMIT 1`, testWorkspaceID).Scan(&agentID); err != nil {
		t.Fatal(err)
	}
	runtime, err := testHandler.Queries.GetAgentRuntime(context.Background(), parseUUID(testRuntimeID))
	if err != nil {
		t.Fatal(err)
	}
	claim := func(cols testutil.Cols, meetingDirs ...string) (string, string) {
		project := dbfx.Project(t, "交付项目", cols)
		issueID := dbfx.Issue(t, "领取任务", testutil.Cols{"workspace_id": testWorkspaceID, "project_id": project})
		for _, dir := range meetingDirs {
			meetingID := dbfx.Insert(t, "cockpit_meeting", testutil.Cols{
				"workspace_id": testWorkspaceID, "cockpit_id": uuid.NewString(), "title": "会议", "nas_dir": dir,
			})
			dbfx.Exec(t, `INSERT INTO cockpit_meeting_issue(workspace_id,meeting_id,issue_id,roles) VALUES($1,$2,$3,'{preparation}')`,
				testWorkspaceID, meetingID, issueID)
			dbfx.Cleanup(t, "DELETE FROM cockpit_meeting_issue WHERE meeting_id=$1", meetingID)
		}
		taskID := dbfx.Task(t, agentID, testutil.Cols{"issue_id": issueID, "runtime_id": testRuntimeID, "status": "dispatched"})
		task, err := testHandler.Queries.GetAgentTask(context.Background(), parseUUID(taskID))
		if err != nil {
			t.Fatal(err)
		}
		resp, _, _, _, _, failure := testHandler.buildClaimedTaskResponse(
			newOwnerDaemonRequest("POST", "/api/daemon/tasks/"+taskID+"/claim", nil), &task, runtime, testRuntimeID, testWorkspaceID)
		if failure != nil {
			t.Fatalf("claim: %+v", failure)
		}
		return resp.DeliveryDirectory, resp.DeliveryDirectorySource
	}
	if got, source := claim(testutil.Cols{"workspace_id": testWorkspaceID, "collab_path": collab}); got != collab || source != "filing" {
		t.Fatalf("claim delivery directory = %q (%s), want %q (filing)", got, source, collab)
	}
	if entries, err := os.ReadDir(collab); err != nil || len(entries) != 0 {
		t.Fatalf("claim wrote to the share: %v %v", entries, err)
	}
	if got, source := claim(testutil.Cols{"workspace_id": testWorkspaceID}); got != "" || source != "" {
		t.Fatalf("a project without collab_path named a folder: %q (%s)", got, source)
	}
	meetingDir := filepath.Join(collab, "20261127-01 周会")
	if got, source := claim(testutil.Cols{"workspace_id": testWorkspaceID, "collab_path": collab}, meetingDir); got != meetingDir || source != "meeting" {
		t.Fatalf("meeting work claimed %q (%s), want the meeting folder %q", got, source, meetingDir)
	}
	if got, source := claim(testutil.Cols{"workspace_id": testWorkspaceID, "collab_path": collab}, meetingDir, filepath.Join(collab, "20261127-02 评审会")); got != collab || source != "filing" {
		t.Fatalf("work for two meeting folders claimed %q (%s), want the filing folder %q", got, source, collab)
	}
}
