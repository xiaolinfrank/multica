package handler

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// A meeting path is composed from the stable directory names the plan records,
// not from titles matched against the disk. Renaming a module or work item on
// the platform must not file new meetings beside the folder people work in.
func TestCockpitMeetingPathUsesStoredDirectoryNames(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Meeting path uses directory names", true)
	renamedModule := "06.06改名后的模块目录"
	renamedWorkItem := "06.06.03改名后的工作项目录"
	dbfx.Exec(t, "UPDATE module SET directory_name = $2 WHERE id = $1", f.module, renamedModule)
	dbfx.Exec(t, `UPDATE cockpit_node SET directory_name = $2 WHERE module_id = $1`, f.module, renamedModule)
	dbfx.Exec(t, `UPDATE cockpit_node SET directory_name = $2 WHERE id = $1`, f.node, renamedWorkItem)

	// A folder that still answers to the titles: a title match would pick these
	// and file the meeting where the platform no longer says it belongs.
	if err := os.Mkdir(filepath.Join(f.root, "06.06 多方协同与会议"), 0o755); err != nil {
		t.Fatalf("setup: %v", err)
	}
	if err := os.Mkdir(filepath.Join(f.moduleDir, "06.06.03 会议纪要与素材"), 0o755); err != nil {
		t.Fatalf("setup: %v", err)
	}

	var dest CockpitMeetingDestinationResponse
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitMeetingDestination),
		cockpitRequest(http.MethodGet, "/api/cockpit/meetings/destination?node_id="+f.node, f.wsID, nil)).
		Want(http.StatusOK).
		JSON(&dest)

	want := filepath.Join(f.root, renamedModule, renamedWorkItem)
	if dest.Error != "" || dest.BaseDir != want {
		t.Fatalf("base_dir = %q err = %q, want the stored directory names %q", dest.BaseDir, dest.Error, want)
	}
	// Naming only the work item fills the project and module in from its parent
	// module row, so the form and the board cannot disagree about the filing.
	if dest.ProjectID != f.project || dest.ModuleID != f.module {
		t.Errorf("derived project/module = %q/%q, want %q/%q", dest.ProjectID, dest.ModuleID, f.project, f.module)
	}
}

// A stored name is a path segment, not a path. A value that could leave its
// parent is reported rather than silently rewritten.
func TestCockpitMeetingPathRefusesUnsafeDirectoryNames(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Meeting path unsafe names", true)

	dbfx.Exec(t, "UPDATE module SET directory_name = $2 WHERE id = $1", f.module, "../escape")
	var outside CockpitMeetingDestinationResponse
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitMeetingDestination),
		cockpitRequest(http.MethodGet,
			"/api/cockpit/meetings/destination?project_id="+f.project+"&module_id="+f.module, f.wsID, nil)).
		Want(http.StatusOK).
		JSON(&outside)
	if outside.BaseDir != "" || !strings.Contains(outside.Error, "single safe path segment") {
		t.Errorf("unsafe module directory name answered %+v", outside)
	}

	dbfx.Exec(t, "UPDATE module SET directory_name = $2 WHERE id = $1", f.module, "06.06多方协同与会议")
	dbfx.Exec(t, `UPDATE cockpit_node SET directory_name = $2 WHERE id = $1`, f.node, "..")
	var workItem CockpitMeetingDestinationResponse
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitMeetingDestination),
		cockpitRequest(http.MethodGet,
			"/api/cockpit/meetings/destination?project_id="+f.project+"&module_id="+f.module+"&node_id="+f.node, f.wsID, nil)).
		Want(http.StatusOK).
		JSON(&workItem)
	if workItem.BaseDir != "" || !strings.Contains(workItem.Error, "single safe path segment") {
		t.Errorf("unsafe work item directory name answered %+v", workItem)
	}
}

// A work item's parent module row is its module. A request that names the work
// item together with a different module is a contradiction, not a filing.
func TestCockpitMeetingDestinationRefusesCrossModuleWorkItem(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Meeting destination cross module", true)
	otherProject := dbfx.Project(t, "另一项目", testutil.Cols{"workspace_id": f.wsID, "collab_path": f.root})
	otherModule := dbfx.Module(t, otherProject, "另一模块", testutil.Cols{"workspace_id": f.wsID})
	cockpitID := dbfx.QueryRow(t, "SELECT id::text FROM cockpit WHERE workspace_id=$1", f.wsID)
	var boardID string
	cockpitID.Scan(&boardID)
	otherRoot := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": f.wsID, "cockpit_id": boardID, "project_id": otherProject,
		"code": "07", "name": "另一项目", "position": 0,
	})
	otherL2 := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": f.wsID, "cockpit_id": boardID, "parent_id": otherRoot,
		"project_id": otherProject, "module_id": otherModule,
		"code": "07.01", "name": "另一模块", "position": 0,
	})
	otherWorkItem := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": f.wsID, "cockpit_id": boardID, "parent_id": otherL2,
		"code": "07.01.01", "name": "另一工作项", "position": 0,
	})

	var mismatched CockpitMeetingDestinationResponse
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitMeetingDestination),
		cockpitRequest(http.MethodGet,
			"/api/cockpit/meetings/destination?project_id="+f.project+"&module_id="+f.module+"&node_id="+otherWorkItem, f.wsID, nil)).
		Want(http.StatusBadRequest).
		JSON(&mismatched)
	if !strings.Contains(mismatched.Error, "does not belong to the selected") {
		t.Errorf("cross-module work item answered %+v", mismatched)
	}

	// Naming only the work item stores its parent pair with it.
	patchCockpit(t, f.wsID, map[string]any{"meeting_node_id": f.node}).Want(http.StatusOK)
	board := getBoard(t, f.wsID)
	if board.Cockpit.MeetingProjectID == nil || *board.Cockpit.MeetingProjectID != f.project ||
		board.Cockpit.MeetingModuleID == nil || *board.Cockpit.MeetingModuleID != f.module {
		t.Errorf("board filing = %v/%v, want the work item's parent pair %s/%s",
			board.Cockpit.MeetingProjectID, board.Cockpit.MeetingModuleID, f.project, f.module)
	}
}

// Meetings link to a project, a module or a work item — never to a fourth
// level. All three write paths refuse one with the same answer.
func TestCockpitMeetingNodeLinksStopAtWorkItems(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Meeting link depth", true)
	meeting := createMeeting(t, f.wsID, map[string]any{"meet_date": "2026-09-21", "title": "周例会"})
	// The reconciled board refuses a fourth level through the ordinary create
	// endpoint, so the legacy row is written directly: a corrupted or imported
	// tree is exactly what the link guard has to survive.
	cockpitID := dbfx.QueryRow(t, "SELECT id::text FROM cockpit WHERE workspace_id=$1", f.wsID)
	var boardID string
	cockpitID.Scan(&boardID)
	fourth := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": f.wsID, "cockpit_id": boardID, "parent_id": f.node,
		"code": "06.06.03.01", "name": "第四层", "position": 0,
	})

	setMeetingNodes(t, f.wsID, meeting.ID, map[string]any{
		"node_ids": []string{fourth}, "replace": true,
	}).Want(http.StatusBadRequest)
	testutil.Call(t, cockpitHandler(testHandler.AppendCockpitMeetingNode),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPost, "/api/cockpit/meetings/"+meeting.ID+"/nodes", f.wsID, map[string]any{"node_id": fourth}),
			"meetingId", meeting.ID,
		)).
		Want(http.StatusBadRequest)
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitMeeting),
		cockpitRequest(http.MethodPost, "/api/cockpit/meetings", f.wsID, map[string]any{
			"title": "带第四层节点", "meet_date": "2026-09-21", "node_id": fourth,
		})).
		Want(http.StatusBadRequest)

	// The three levels the contract does allow still link.
	projectRow := dbfx.QueryRow(t, `SELECT id::text FROM cockpit_node WHERE workspace_id=$1 AND project_id=$2 AND parent_id IS NULL LIMIT 1`, f.wsID, f.project)
	var projectRowID, moduleRowID string
	projectRow.Scan(&projectRowID)
	dbfx.QueryRow(t, `SELECT id::text FROM cockpit_node WHERE workspace_id=$1 AND module_id=$2 LIMIT 1`, f.wsID, f.module).Scan(&moduleRowID)
	setMeetingNodes(t, f.wsID, meeting.ID, map[string]any{
		"node_ids": []string{projectRowID, moduleRowID, f.node}, "replace": true,
	}).Want(http.StatusOK)
}

// The minutes task of a meeting filed at a work item belongs to that work item
// from birth: work_item_id is its filing, and the "related work items" list
// does not repeat the same row as a second link.
func TestCockpitMeetingWorkPackageFilesAtWorkItem(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Meeting work package work item", true)
	dbfx.Cleanup(t, "DELETE FROM cockpit_meeting_work_package WHERE workspace_id=$1", f.wsID)
	dbfx.Cleanup(t, "DELETE FROM cockpit_minutes_version WHERE workspace_id=$1", f.wsID)
	dbfx.Cleanup(t, "DELETE FROM cockpit_reviewer_handoff WHERE workspace_id=$1", f.wsID)
	dbfx.Cleanup(t, "DELETE FROM cockpit_minutes_export WHERE workspace_id=$1", f.wsID)
	dbfx.Cleanup(t, "DELETE FROM cockpit_minutes_export_attempt WHERE workspace_id=$1", f.wsID)
	reviewer := dbfx.User(t, "纪要审核人", "review-"+uuid.NewString()+"@example.com")
	dbfx.Member(t, f.wsID, reviewer, "member")
	patchCockpit(t, f.wsID, map[string]any{
		"meeting_project_id": f.project, "meeting_module_id": f.module, "meeting_node_id": f.node,
	}).Want(http.StatusOK)

	meeting := createMeeting(t, f.wsID, map[string]any{"meet_date": "2026-09-21", "title": "周例会"})
	var state CockpitMeetingWorkflowResponse
	callCockpitWorkflow(t, testHandler.EnableCockpitMeetingWorkflow, http.MethodPost, f.wsID, meeting.ID, "", "",
		map[string]any{"reviewer_id": reviewer}).Want(http.StatusOK).JSON(&state)
	if state.MinutesIssue == nil {
		t.Fatal("enabling the work package opened no minutes task")
	}
	minutesID := state.MinutesIssue.ID
	var projectID, moduleID, workItemID *string
	dbfx.QueryRow(t, "SELECT project_id::text, module_id::text, work_item_id::text FROM issue WHERE id=$1", minutesID).
		Scan(&projectID, &moduleID, &workItemID)
	if projectID == nil || *projectID != f.project || moduleID == nil || *moduleID != f.module || workItemID == nil || *workItemID != f.node {
		t.Errorf("minutes task filing = %v/%v/%v, want %s/%s/%s", projectID, moduleID, workItemID, f.project, f.module, f.node)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM cockpit_node_issue WHERE issue_id=$1 AND node_id=$2", minutesID, f.node); n != 0 {
		t.Errorf("the archive work item is repeated as a related link (%d rows)", n)
	}

	// Re-sending the same initialization keeps the one task and its filing.
	callCockpitWorkflow(t, testHandler.EnableCockpitMeetingWorkflow, http.MethodPost, f.wsID, meeting.ID, "", "",
		map[string]any{"reviewer_id": reviewer}).Want(http.StatusOK).JSON(&state)
	if state.MinutesIssue.ID != minutesID {
		t.Errorf("retry opened a second minutes task: %s vs %s", state.MinutesIssue.ID, minutesID)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", f.wsID); n != 1 {
		t.Errorf("retry left %d issues, want one", n)
	}
}

// A request that clears a level must send that level, not omit it: an omitted
// module_id falls back to the board's stored module, which is how a preview of
// "P1 / M2" was answered with P1's old work item and refused as a
// contradiction. `module_id=` and `node_id=` are explicit clearings.
func TestCockpitMeetingDestinationHonoursClearedLevels(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Meeting destination cleared levels", true)
	otherModuleDir := "06.07另一模块"
	otherModule := dbfx.Module(t, f.project, "06.07 另一模块", testutil.Cols{
		"workspace_id": f.wsID, "directory_name": otherModuleDir,
	})
	if err := os.Mkdir(filepath.Join(f.root, otherModuleDir), 0o755); err != nil {
		t.Fatalf("setup: %v", err)
	}
	otherRoot := t.TempDir()
	otherProject := dbfx.Project(t, "07另一项目", testutil.Cols{
		"workspace_id": f.wsID, "collab_path": otherRoot,
	})
	patchCockpit(t, f.wsID, map[string]any{
		"meeting_project_id": f.project, "meeting_module_id": f.module, "meeting_node_id": f.node,
	}).Want(http.StatusOK)

	cases := []struct {
		name      string
		query     string
		wantDir   string
		wantError string
	}{
		{
			name:    "work item cleared keeps the module",
			query:   "?project_id=" + f.project + "&module_id=" + f.module + "&node_id=",
			wantDir: filepath.Join(f.root, "06.06多方协同与会议"),
		},
		{
			name:    "another module does not inherit the old work item",
			query:   "?project_id=" + f.project + "&module_id=" + otherModule + "&node_id=",
			wantDir: filepath.Join(f.root, otherModuleDir),
		},
		{
			name:    "another module without a node parameter still drops the work item",
			query:   "?project_id=" + f.project + "&module_id=" + otherModule,
			wantDir: filepath.Join(f.root, otherModuleDir),
		},
		{
			name:    "project only does not inherit the old module or work item",
			query:   "?project_id=" + otherProject + "&module_id=&node_id=",
			wantDir: otherRoot,
		},
		{
			name:    "another project without a module parameter still drops the module",
			query:   "?project_id=" + otherProject + "&node_id=",
			wantDir: otherRoot,
		},
		{
			name:    "an emptied module keeps the board's project",
			query:   "?project_id=" + f.project + "&module_id=&node_id=",
			wantDir: f.root,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var dest CockpitMeetingDestinationResponse
			testutil.Call(t, cockpitHandler(testHandler.GetCockpitMeetingDestination),
				cockpitRequest(http.MethodGet, "/api/cockpit/meetings/destination"+tc.query, f.wsID, nil)).
				Want(http.StatusOK).
				JSON(&dest)
			if dest.Error != "" || dest.BaseDir != tc.wantDir {
				t.Fatalf("base_dir = %q err = %q, want %q", dest.BaseDir, dest.Error, tc.wantDir)
			}
		})
	}

	// The scan reads the same destination, so it must honour the same empty
	// fields instead of announcing the old work item's folder.
	var scan CockpitMeetingScanResponse
	testutil.Call(t, cockpitHandler(testHandler.ScanCockpitMeetingFolders),
		cockpitRequest(http.MethodGet,
			"/api/cockpit/meetings/scan?project_id="+f.project+"&module_id="+otherModule+"&node_id=", f.wsID, nil)).
		Want(http.StatusOK).
		JSON(&scan)
	if scan.BaseDir != filepath.Join(f.root, otherModuleDir) {
		t.Fatalf("scan base_dir = %q err = %q, want %q", scan.BaseDir, scan.Error, filepath.Join(f.root, otherModuleDir))
	}
}

// An old board that was never reconciled can carry a standalone archive row:
// no parent, no project, no module. Its own name IS the last folder segment,
// even though the row sits at depth 0.
func TestCockpitMeetingPathKeepsStandaloneArchiveRow(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Meeting path standalone archive", true)
	dbfx.Exec(t, "UPDATE cockpit SET plan_reconciled_at = NULL WHERE workspace_id = $1", f.wsID)
	cockpitID := dbfx.QueryRow(t, "SELECT id::text FROM cockpit WHERE workspace_id=$1", f.wsID)
	var boardID string
	cockpitID.Scan(&boardID)
	standalone := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": f.wsID, "cockpit_id": boardID,
		"code": "09.09", "name": "独立归档", "directory_name": "09.09独立归档", "position": 0,
	})

	var dest CockpitMeetingDestinationResponse
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitMeetingDestination),
		cockpitRequest(http.MethodGet,
			"/api/cockpit/meetings/destination?project_id="+f.project+"&node_id="+standalone, f.wsID, nil)).
		Want(http.StatusOK).
		JSON(&dest)

	want := filepath.Join(f.root, "09.09独立归档")
	if dest.Error != "" || dest.BaseDir != want {
		t.Fatalf("base_dir = %q err = %q, want %q", dest.BaseDir, dest.Error, want)
	}
	if dest.BaseDirExists {
		t.Errorf("base_dir_exists = true, but the folder was never created: the name must be composed, not scanned for")
	}
}

// On a reconciled board a project row or module row names one branch. Naming
// a row from another branch is a contradiction; naming only the row fills its
// project and module in.
func TestCockpitMeetingDestinationRefusesCrossBranchRows(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Meeting destination cross branch", true)
	otherRoot := t.TempDir()
	otherProject := dbfx.Project(t, "07另一项目", testutil.Cols{
		"workspace_id": f.wsID, "collab_path": otherRoot,
	})
	cockpitID := dbfx.QueryRow(t, "SELECT id::text FROM cockpit WHERE workspace_id=$1", f.wsID)
	var boardID string
	cockpitID.Scan(&boardID)
	otherL1 := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": f.wsID, "cockpit_id": boardID, "project_id": otherProject,
		"code": "07", "name": "07另一项目", "position": 1,
	})
	projectRowID := dbfx.QueryRow(t,
		"SELECT id::text FROM cockpit_node WHERE workspace_id=$1 AND project_id=$2 AND parent_id IS NULL LIMIT 1",
		f.wsID, f.project)
	var ownL1 string
	projectRowID.Scan(&ownL1)
	otherModuleDir := "06.07另一模块"
	otherModule := dbfx.Module(t, f.project, "06.07 另一模块", testutil.Cols{
		"workspace_id": f.wsID, "directory_name": otherModuleDir,
	})
	otherL2 := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": f.wsID, "cockpit_id": boardID, "parent_id": ownL1,
		"project_id": f.project, "module_id": otherModule,
		"code": "06.07", "name": "06.07 另一模块", "position": 1,
	})

	refused := []string{
		"?project_id=" + f.project + "&module_id=" + f.module + "&node_id=" + otherL1,
		"?project_id=" + f.project + "&module_id=" + f.module + "&node_id=" + otherL2,
	}
	for _, query := range refused {
		var dest CockpitMeetingDestinationResponse
		testutil.Call(t, cockpitHandler(testHandler.GetCockpitMeetingDestination),
			cockpitRequest(http.MethodGet, "/api/cockpit/meetings/destination"+query, f.wsID, nil)).
			Want(http.StatusBadRequest).
			JSON(&dest)
		if strings.TrimSpace(dest.Error) == "" {
			t.Errorf("%s was refused without a reason", query)
		}
	}

	// A module from another project is refused as well, through the preview's
	// own error field: that is how "no folder can be worked out" reads.
	var crossProject CockpitMeetingDestinationResponse
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitMeetingDestination),
		cockpitRequest(http.MethodGet,
			"/api/cockpit/meetings/destination?project_id="+otherProject+"&module_id="+f.module+"&node_id=", f.wsID, nil)).
		Want(http.StatusOK).
		JSON(&crossProject)
	if !strings.Contains(crossProject.Error, "does not belong to the selected project") || crossProject.BaseDir != "" {
		t.Errorf("cross-project module answered %+v", crossProject)
	}

	// Naming only the row fills in the branch it belongs to.
	cases := []struct {
		query    string
		wantDir  string
		wantProj string
		wantMod  string
	}{
		{"?node_id=" + otherL1, otherRoot, otherProject, ""},
		{"?node_id=" + otherL2, filepath.Join(f.root, otherModuleDir), f.project, otherModule},
	}
	for _, tc := range cases {
		var dest CockpitMeetingDestinationResponse
		testutil.Call(t, cockpitHandler(testHandler.GetCockpitMeetingDestination),
			cockpitRequest(http.MethodGet, "/api/cockpit/meetings/destination"+tc.query, f.wsID, nil)).
			Want(http.StatusOK).
			JSON(&dest)
		if dest.Error != "" || dest.BaseDir != tc.wantDir || dest.ProjectID != tc.wantProj || dest.ModuleID != tc.wantMod {
			t.Errorf("%s answered base_dir %q (%s) for %q/%q, want %q for %q/%q",
				tc.query, dest.BaseDir, dest.Error, dest.ProjectID, dest.ModuleID, tc.wantDir, tc.wantProj, tc.wantMod)
		}
	}
}
