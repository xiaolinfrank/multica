//go:build darwin || linux

package handler

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestCockpitMeetingFilesAllowAncestorAliasButRejectFinalRootLink(t *testing.T) {
	parent, aliasParent := t.TempDir(), t.TempDir()
	root := filepath.Join(parent, "configured")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(aliasParent, "ancestor")
	if err := os.Symlink(parent, alias); err != nil {
		t.Fatal(err)
	}
	if _, err := createMeetingDir(filepath.Join(alias, "configured"), "Meeting"); err != nil {
		t.Fatalf("configured root below a platform alias: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "Meeting")); err != nil {
		t.Fatal(err)
	}
	rootLink := filepath.Join(aliasParent, "root-link")
	if err := os.Symlink(root, rootLink); err != nil {
		t.Fatal(err)
	}
	if _, err := createMeetingDir(rootLink, "Rejected"); err == nil {
		t.Fatal("followed a final root link")
	}
	if _, err := os.Stat(filepath.Join(root, "Rejected")); !os.IsNotExist(err) {
		t.Fatal("wrote through root link")
	}
}

func TestCockpitMeetingFilesRefuseLinksNonDirectoriesAndDisplacedHandles(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "existing-file"), []byte("Keep existing bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"escape", "existing-file"} {
		if _, err := createMeetingDir(root, name); err == nil {
			t.Fatalf("accepted non-directory %s as a created folder", name)
		}
	}
	if err := ensureMeetingBase(root, filepath.Join(root, "escape", "nested")); err == nil {
		t.Fatal("followed child link outside root")
	}
	if _, err := os.Stat(filepath.Join(outside, "nested")); !os.IsNotExist(err) {
		t.Fatal("created an escaped child")
	}
	archive, err := openMeetingArchive(root)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.close()
	child, err := archive.directory(filepath.Join(root, "nested"), true)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(child.path, filepath.Join(root, "displaced")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, child.path); err != nil {
		t.Fatal(err)
	}
	if _, err := child.child("blocked", true); err == nil {
		t.Fatal("a displaced open handle was confirmed")
	}
	for _, p := range []string{filepath.Join(outside, "blocked"), filepath.Join(root, "displaced", "blocked")} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatal("wrote after displacement")
		}
	}
	content, err := os.ReadFile(filepath.Join(root, "existing-file"))
	if err != nil || string(content) != "Keep existing bytes" {
		t.Fatal("changed an existing file")
	}
}

func TestCockpitMeetingFilesRefuseReplacedConfiguredRoot(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "root")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	archive, err := openMeetingArchive(root)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.close()
	dir, err := archive.directory(root, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(root, root+"-old"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := dir.child("blocked", true); err == nil {
		t.Fatal("acknowledged a replaced configured root")
	}
	for _, p := range []string{filepath.Join(root, "blocked"), filepath.Join(root+"-old", "blocked")} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatal("wrote after root replacement")
		}
	}
}

func TestCockpitMeetingFilesImportAndProvisionCannotEscapeConfiguredRoot(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Safe meeting directories", true)
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(f.archiveDir, "Escape")); err != nil {
		t.Fatal(err)
	}
	patchCockpit(t, f.wsID, map[string]any{"meeting_project_id": f.project, "meeting_module_id": f.module, "meeting_node_id": f.node, "meeting_dir": f.archiveDir}).Want(200)
	var imported CockpitMeetingImportResponse
	testutil.Call(t, cockpitHandler(testHandler.ImportCockpitMeetingFolders), cockpitRequest("POST", "/import", f.wsID,
		map[string]any{"items": []map[string]any{{"name": "Escape", "title": "Escape"}}})).Want(200).JSON(&imported)
	if len(imported.Meetings) != 0 || len(imported.Skipped) != 1 {
		t.Fatalf("import followed linked folder: %+v", imported)
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatal("import wrote default drawers outside configured root")
	}
	meeting := createMeeting(t, f.wsID, map[string]any{"title": "Safe fixture"})
	result := f.provision(t, meeting.ID, map[string]any{"create_task": false, "base_dir": outside, "folder_name": "NeverCreate", "remember": false})
	if result.DirCreated || !strings.Contains(result.DirError, "outside") {
		t.Fatalf("single request upgraded a foreign directory into a root: %+v", result)
	}
	if _, err := os.Stat(filepath.Join(outside, "NeverCreate")); !os.IsNotExist(err) {
		t.Fatal("provision escaped its configured root")
	}
	invalid := filepath.Join(f.archiveDir, "invalid\npath")
	result = f.provision(t, meeting.ID, map[string]any{"create_task": false, "base_dir": invalid, "folder_name": "NeverCreate", "remember": false})
	if result.DirCreated || result.DirError == "" {
		t.Fatal("provision bypassed the normal directory-path input boundary")
	}
	if _, err := os.Stat(invalid); !os.IsNotExist(err) {
		t.Fatal("created a directory with a rejected control character")
	}
	inside := filepath.Join(f.archiveDir, "Scoped child")
	result = f.provision(t, meeting.ID, map[string]any{"create_task": false, "base_dir": inside, "folder_name": "Meeting", "remember": false})
	if !result.DirCreated || result.DirError != "" || result.Dir != filepath.Join(inside, "Meeting") {
		t.Fatalf("valid narrowing failed: %+v", result)
	}
	var scan CockpitMeetingScanResponse
	testutil.Call(t, cockpitHandler(testHandler.ScanCockpitMeetingFolders), cockpitRequest("GET", "/scan", f.wsID, nil)).Want(200).JSON(&scan)
	for _, entry := range scan.Entries {
		if entry.Name == "Escape" {
			t.Fatal("scan followed a linked child")
		}
	}
}

func TestCockpitMeetingFilesValidateReferencesBeforeConfirmedRootOrRemember(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Directory reference guards", true)
	patchCockpit(t, f.wsID, map[string]any{"meeting_project_id": f.project, "meeting_module_id": f.module, "meeting_node_id": f.node, "meeting_dir": f.archiveDir}).Want(200)
	meeting := createMeeting(t, f.wsID, map[string]any{"title": "Reference guard"})
	foreign := dbfx.Project(t, "Foreign project")
	other := dbfx.Project(t, "Other local project", testutil.Cols{"workspace_id": f.wsID})
	otherModule := dbfx.Module(t, other, "Other module", testutil.Cols{"workspace_id": f.wsID})
	patchCockpit(t, f.wsID, map[string]any{"meeting_project_id": other}).Want(400)
	for _, body := range []map[string]any{{"project_id": foreign}, {"module_id": otherModule}} {
		body["create_dir"], body["create_task"], body["remember"] = false, false, true
		testutil.Call(t, cockpitHandler(testHandler.ProvisionCockpitMeeting), testutil.WithURLParams(cockpitRequest("POST", "/provision", f.wsID, body), "meetingId", meeting.ID)).Want(400)
	}
	var count int
	if err := testPool.QueryRow(t.Context(), "SELECT count(*) FROM cockpit WHERE workspace_id=$1 AND meeting_project_id=$2 AND meeting_module_id=$3 AND meeting_dir=$4", f.wsID, f.project, f.module, f.archiveDir).Scan(&count); err != nil || count != 1 {
		t.Fatalf("invalid reference changed remembered configuration: %d %v", count, err)
	}
	patchCockpit(t, f.wsID, map[string]any{"meeting_project_id": other, "meeting_module_id": otherModule, "meeting_node_id": ""}).Want(200)
	if err := testPool.QueryRow(t.Context(), "SELECT count(*) FROM cockpit WHERE workspace_id=$1 AND meeting_project_id=$2 AND meeting_dir=''", f.wsID, other).Scan(&count); err != nil || count != 1 {
		t.Fatalf("new selection inherited a previously confirmed directory: %d %v", count, err)
	}
}

func TestCockpitMeetingFilesRememberedWriterMustBelongToWorkspace(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Remember writer boundary", true)
	meeting := createMeeting(t, f.wsID, map[string]any{"title": "Remember writer"})
	foreign := dbfx.User(t, "Foreign writer", "foreign-writer-"+f.wsID+"@example.com")
	for _, entry := range []map[string]any{{"assignee_type": "member", "assignee_id": foreign}, {"assignee_type": "future", "assignee_id": testUserID}, {"assignee_type": "member", "assignee_id": ""}} {
		entry["project_id"], entry["module_id"], entry["create_dir"], entry["create_task"], entry["remember"] = f.project, f.module, false, false, true
		testutil.Call(t, cockpitHandler(testHandler.ProvisionCockpitMeeting), testutil.WithURLParams(cockpitRequest("POST", "/provision", f.wsID, entry), "meetingId", meeting.ID)).Want(400)
	}
	if count := dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1 AND meeting_assignee_id IS NOT NULL", f.wsID); count != 0 {
		t.Fatal("invalid writer was remembered")
	}
	f.provision(t, meeting.ID, map[string]any{"project_id": f.project, "module_id": f.module, "create_dir": false, "create_task": false, "remember": true, "assignee_type": "member", "assignee_id": testUserID})
	if count := dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1 AND meeting_assignee_type='member' AND meeting_assignee_id=$2", f.wsID, testUserID); count != 1 {
		t.Fatal("valid member was not remembered")
	}
	if count := dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", f.wsID); count != 0 {
		t.Fatal("remembering a writer created work")
	}
}
