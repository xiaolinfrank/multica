//go:build darwin || linux

package handler

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Fail the actual read if a directory operation regresses to loading history
// bodies. The fixture remains a real PostgreSQL/owned-filesystem integration.
type meetingDirectoryReadAudit struct {
	db.DBTX
	metadataReads, directoryReads int
}

func (a *meetingDirectoryReadAudit) Query(ctx context.Context, query string, args ...any) (pgx.Rows, error) {
	if strings.Contains(query, "-- name: ListCockpitMeetings :many") {
		return nil, errors.New("directory operations must not read full meeting history")
	}
	if strings.Contains(query, "-- name: ListCockpitMeetingDirectoryMetadata :many") || strings.Contains(query, "-- name: ListCockpitMeetingRecordedDirectories :many") {
		start, end := strings.Index(query, "SELECT "), strings.Index(query, "FROM cockpit_meeting")
		if start < 0 || end < start {
			return nil, errors.New("missing metadata projection")
		}
		projection := strings.ToLower(query[start:end])
		for _, forbidden := range []string{"*", "note", "minutes", "actions", "decisions"} {
			if strings.Contains(projection, forbidden) {
				return nil, errors.New("directory lookup selected a meeting body")
			}
		}
		if strings.Contains(query, "DirectoryMetadata") {
			a.metadataReads++
		} else {
			a.directoryReads++
		}
	}
	return a.DBTX.Query(ctx, query, args...)
}
func TestCockpitMeetingDirectoryMatchingDoesNotReadHistoryBodies(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Bodyless archive lookup", true)
	directName, namedName := "Registered physical folder", "BY-NAME Meeting without a stored directory"
	for _, name := range []string{directName, namedName, "2026-10-10"} {
		if err := os.Mkdir(filepath.Join(f.archiveDir, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	direct := createMeeting(t, f.wsID, map[string]any{"title": "Different display title", "nas_dir": filepath.Join(f.archiveDir, directName)})
	named := createMeeting(t, f.wsID, map[string]any{"title": "Meeting without a stored directory", "code": "BY-NAME"})
	// Imported historical rows may have no code/title; retain the date fallback.
	var boardID string
	if err := testPool.QueryRow(t.Context(), "SELECT id FROM cockpit WHERE workspace_id=$1", f.wsID).Scan(&boardID); err != nil {
		t.Fatal(err)
	}
	dated := dbfx.Insert(t, "cockpit_meeting", testutil.Cols{"workspace_id": f.wsID, "cockpit_id": boardID, "code": "", "title": "", "meet_date": "2026-10-10"})
	body := "PRIVATE_BODY_MARKER " + strings.Repeat("Long historical minutes. ", 4096)
	dbfx.Exec(t, "UPDATE cockpit_meeting SET note=$1,minutes=$1,actions=$1,decisions=$1 WHERE workspace_id=$2", body, f.wsID)
	other := cockpitMeetingFixture(t, "Other archive scope")
	createMeeting(t, other, map[string]any{"title": "Foreign folder reference", "nas_dir": filepath.Join(f.archiveDir, directName)})
	audit := &meetingDirectoryReadAudit{DBTX: testPool}
	h := *testHandler
	h.Queries = db.New(audit)
	var scan CockpitMeetingScanResponse
	response := testutil.Call(t, cockpitHandler(h.ScanCockpitMeetingFolders), cockpitRequest("GET", "/scan?project_id="+f.project+"&module_id="+f.module+"&node_id="+f.node, f.wsID, nil)).Want(200)
	response.JSON(&scan)
	if scan.Error != "" || scan.Matched != 3 || len(scan.Entries) != 3 {
		t.Fatalf("metadata lost folder matching: %+v", scan)
	}
	expected := map[string]string{directName: direct.ID, namedName: named.ID, "2026-10-10": dated}
	for _, entry := range scan.Entries {
		if entry.MeetingID != expected[entry.Name] {
			t.Fatalf("incorrect directory/name fallback: %+v", entry)
		}
	}
	if strings.Contains(response.Body.String(), "PRIVATE_BODY_MARKER") || response.Body.Len() > 10000 {
		t.Fatal("scan response contains meeting bodies")
	}
	var imported CockpitMeetingImportResponse
	testutil.Call(t, cockpitHandler(h.ImportCockpitMeetingFolders), cockpitRequest("POST", "/import", f.wsID, map[string]any{"project_id": f.project, "module_id": f.module, "node_id": f.node, "items": []map[string]any{{"name": directName, "title": "Do not duplicate"}}})).Want(200).JSON(&imported)
	if len(imported.Meetings) != 0 || len(imported.Skipped) != 1 || imported.Skipped[0].Reason != "already in the register" {
		t.Fatalf("import lost directory duplicate detection: %+v", imported)
	}
	if audit.metadataReads != 1 || audit.directoryReads != 1 {
		t.Fatalf("unexpected directory query path: metadata=%d paths=%d", audit.metadataReads, audit.directoryReads)
	}
	if count := dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting WHERE workspace_id=$1", f.wsID); count != 3 {
		t.Fatal("directory scan/import duplicated a recorded meeting")
	}
}

func TestCockpitMeetingDirectoryReadsAndStaleImportDoNotInitializeOrWrite(t *testing.T) {
	ws := cockpitFixture(t, "Directory preview before first meeting")
	oldRoot, newRoot := t.TempDir(), t.TempDir()
	folder := "20261010 Review"
	for _, root := range []string{oldRoot, newRoot} {
		if err := os.MkdirAll(filepath.Join(root, "Module", folder), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	project := dbfx.Project(t, "Project", testutil.Cols{"workspace_id": ws, "collab_path": oldRoot})
	module := dbfx.Module(t, project, "Module", testutil.Cols{"workspace_id": ws})
	query := "?project_id=" + project + "&module_id=" + module
	// Even the unconfigured preview must remain a read.
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitMeetingDestination), cockpitRequest("GET", "/destination", ws, nil)).Want(200)
	var preview CockpitMeetingDestinationResponse
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitMeetingDestination), cockpitRequest("GET", "/destination"+query, ws, nil)).Want(200).JSON(&preview)
	var scanned CockpitMeetingScanResponse
	testutil.Call(t, cockpitHandler(testHandler.ScanCockpitMeetingFolders), cockpitRequest("GET", "/scan"+query, ws, nil)).Want(200).JSON(&scanned)
	if preview.BaseDir != filepath.Join(oldRoot, "Module") || scanned.BaseDir != preview.BaseDir || len(scanned.Entries) != 1 || scanned.Entries[0].Name != folder {
		t.Fatalf("initial read did not return the selected archive: %+v/%+v", preview, scanned)
	}
	if count := dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1", ws); count != 0 {
		t.Fatal("directory GET initialized a board")
	}
	dbfx.Exec(t, "UPDATE project SET collab_path=$1 WHERE workspace_id=$2 AND id=$3", newRoot, ws, project)
	body := map[string]any{"project_id": project, "module_id": module, "expected_base_dir": scanned.BaseDir, "create_task": true, "items": []map[string]any{{"name": folder, "title": "Do not import the other folder"}}}
	var conflict map[string]string
	testutil.Call(t, cockpitHandler(testHandler.ImportCockpitMeetingFolders), cockpitRequest("POST", "/import", ws, body)).Want(409).JSON(&conflict)
	if conflict["code"] != "directory_changed" {
		t.Fatalf("missing explicit re-scan outcome: %+v", conflict)
	}
	for _, table := range []string{"cockpit", "cockpit_meeting", "issue"} {
		if count := dbfx.Count(t, "SELECT count(*) FROM "+table+" WHERE workspace_id=$1", ws); count != 0 {
			t.Fatalf("stale directory import wrote %s", table)
		}
	}
	for _, root := range []string{oldRoot, newRoot} {
		entries, err := os.ReadDir(filepath.Join(root, "Module", folder))
		if err != nil || len(entries) != 0 {
			t.Fatalf("stale import created drawers under %s: %v", root, err)
		}
	}
	// The supplied observation never becomes an authorization root. Only a
	// new scan of the configured destination can authorize the corrected intent.
	testutil.Call(t, cockpitHandler(testHandler.ScanCockpitMeetingFolders), cockpitRequest("GET", "/scan"+query, ws, nil)).Want(200).JSON(&scanned)
	body["expected_base_dir"] = scanned.BaseDir
	body["create_task"] = false
	var imported CockpitMeetingImportResponse
	testutil.Call(t, cockpitHandler(testHandler.ImportCockpitMeetingFolders), cockpitRequest("POST", "/import", ws, body)).Want(200).JSON(&imported)
	if len(imported.Meetings) != 1 || imported.Meetings[0].NasDir != filepath.Join(newRoot, "Module", folder) {
		t.Fatalf("explicit refreshed import failed: %+v", imported)
	}
	if count := dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1", ws); count != 1 {
		t.Fatal("successful import did not initialize its board")
	}
	if entries, err := os.ReadDir(filepath.Join(oldRoot, "Module", folder)); err != nil || len(entries) != 0 {
		t.Fatal("refreshed import touched the old directory")
	}
}
