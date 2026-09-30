package handler

import (
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func listDirectory(t *testing.T, wsID string) CockpitDirectoryResponse {
	t.Helper()
	var resp CockpitDirectoryResponse
	testutil.Call(t, cockpitHandler(testHandler.ListCockpitDirectory),
		cockpitRequest(http.MethodGet, "/api/cockpit/directory", wsID, nil)).
		Want(http.StatusOK).
		JSON(&resp)
	return resp
}

func upsertDirectory(t *testing.T, wsID string, entries []map[string]any) *testutil.Response {
	t.Helper()
	return testutil.Call(t, cockpitHandler(testHandler.UpsertCockpitDirectory),
		cockpitRequest(http.MethodPut, "/api/cockpit/directory", wsID, map[string]any{"entries": entries}))
}

func TestCockpitDirectoryStartsEmpty(t *testing.T) {
	wsID := cockpitFixture(t, "directory-empty")
	resp := listDirectory(t, wsID)
	if len(resp.Entries) != 0 {
		t.Fatalf("expected empty directory, got %d entries", len(resp.Entries))
	}
}

func TestCockpitDirectoryUpsertThenList(t *testing.T) {
	wsID := cockpitFixture(t, "directory-upsert")

	var resp CockpitDirectoryResponse
	upsertDirectory(t, wsID, []map[string]any{
		{"party": "深圳联通", "name": "李明玉", "position": "平台总架构师"},
		{"party": "深圳联通", "name": "丘汉清"},
		{"party": "", "name": "黄晓韵", "position": "PI"},
	}).Want(http.StatusOK).JSON(&resp)
	if len(resp.Entries) != 3 {
		t.Fatalf("expected the refreshed book back, got %d entries", len(resp.Entries))
	}

	listed := listDirectory(t, wsID)
	if len(listed.Entries) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(listed.Entries))
	}
	// ORDER BY party, name: the empty party sorts first.
	first := listed.Entries[0]
	if first.Party != "" || first.Name != "黄晓韵" || first.Position != "PI" {
		t.Fatalf("unexpected first entry: %+v", first)
	}
}

func TestCockpitDirectoryUpsertIsAnUpdate(t *testing.T) {
	wsID := cockpitFixture(t, "directory-update")

	upsertDirectory(t, wsID, []map[string]any{
		{"party": "华为", "name": "黄支学", "position": "方案负责人"},
	}).Want(http.StatusOK)
	upsertDirectory(t, wsID, []map[string]any{
		{"party": "华为", "name": "黄支学", "position": "资深方案负责人"},
	}).Want(http.StatusOK)

	listed := listDirectory(t, wsID)
	if len(listed.Entries) != 1 {
		t.Fatalf("re-save must not duplicate the person, got %d entries", len(listed.Entries))
	}
	if listed.Entries[0].Position != "资深方案负责人" {
		t.Fatalf("expected the new position, got %q", listed.Entries[0].Position)
	}
}

func TestCockpitDirectoryEmptyPositionNeverWipes(t *testing.T) {
	wsID := cockpitFixture(t, "directory-keep-position")

	upsertDirectory(t, wsID, []map[string]any{
		{"party": "华为", "name": "黄支学", "position": "方案负责人"},
	}).Want(http.StatusOK)
	// The auto-save often knows only the name; that must not erase the 职位.
	upsertDirectory(t, wsID, []map[string]any{
		{"party": "华为", "name": "黄支学"},
	}).Want(http.StatusOK)

	listed := listDirectory(t, wsID)
	if listed.Entries[0].Position != "方案负责人" {
		t.Fatalf("a name-only save wiped the position: %q", listed.Entries[0].Position)
	}
}

func TestCockpitDirectoryUpsertRequiresAName(t *testing.T) {
	wsID := cockpitFixture(t, "directory-noname")
	upsertDirectory(t, wsID, []map[string]any{
		{"party": "华为", "position": "方案负责人"},
	}).Want(http.StatusBadRequest)
	upsertDirectory(t, wsID, []map[string]any{
		{"party": "华为", "name": "  "},
	}).Want(http.StatusBadRequest)
	if got := len(listDirectory(t, wsID).Entries); got != 0 {
		t.Fatalf("a rejected entry must not land, got %d entries", got)
	}
}

func TestCockpitDirectoryStaysInItsWorkspace(t *testing.T) {
	wsID := cockpitFixture(t, "directory-scope-a")
	otherID := cockpitFixture(t, "directory-scope-b")

	upsertDirectory(t, wsID, []map[string]any{
		{"party": "深圳联通", "name": "李明玉"},
	}).Want(http.StatusOK)

	if got := len(listDirectory(t, otherID).Entries); got != 0 {
		t.Fatalf("the other workspace sees %d entries", got)
	}
}

func deleteDirectoryEntry(t *testing.T, wsID string, body map[string]any) *testutil.Response {
	t.Helper()
	return testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitDirectoryEntry),
		cockpitRequest(http.MethodDelete, "/api/cockpit/directory", wsID, body))
}

func TestCockpitDirectoryDeleteRemovesAFormRow(t *testing.T) {
	wsID := cockpitFixture(t, "directory-delete")

	upsertDirectory(t, wsID, []map[string]any{
		{"party": "深圳联通", "name": "李明玉", "position": "平台总架构师"},
		{"party": "深圳联通", "name": "丘汉清"},
	}).Want(http.StatusOK)

	var resp CockpitDirectoryResponse
	deleteDirectoryEntry(t, wsID, map[string]any{"party": "深圳联通", "name": "丘汉清"}).
		Want(http.StatusOK).JSON(&resp)
	if len(resp.Entries) != 1 || resp.Entries[0].Name != "李明玉" {
		t.Fatalf("expected only 李明玉 left, got %+v", resp.Entries)
	}
	if got := dbfx.Count(t, "SELECT COUNT(*) FROM cockpit_directory WHERE workspace_id = $1", wsID); got != 1 {
		t.Fatalf("expected 1 row in the book, got %d", got)
	}
}

func TestCockpitDirectoryDeleteRefusesARosterRow(t *testing.T) {
	wsID := cockpitFixture(t, "directory-delete-seed")

	upsertDirectory(t, wsID, []map[string]any{
		{"party": "深圳联通", "name": "李明玉"},
	}).Want(http.StatusOK)
	// The 952 backfill marks the roster by its exact triple; make this row one
	// of those, as if the seed had written it.
	dbfx.Exec(t, "UPDATE cockpit_directory SET source = 'seed' WHERE workspace_id = $1 AND name = '李明玉'", wsID)

	deleteDirectoryEntry(t, wsID, map[string]any{"party": "深圳联通", "name": "李明玉"}).
		Want(http.StatusBadRequest)
	if got := dbfx.Count(t, "SELECT COUNT(*) FROM cockpit_directory WHERE workspace_id = $1 AND name = '李明玉'", wsID); got != 1 {
		t.Fatalf("a roster row must survive the delete, got %d rows", got)
	}
}

func TestCockpitDirectoryDeleteUnknownRowIs404(t *testing.T) {
	wsID := cockpitFixture(t, "directory-delete-404")
	deleteDirectoryEntry(t, wsID, map[string]any{"party": "深圳联通", "name": "不存在的人"}).
		Want(http.StatusNotFound)
	deleteDirectoryEntry(t, wsID, map[string]any{"party": "深圳联通"}).
		Want(http.StatusBadRequest)
}

func TestCockpitDirectoryDeleteStaysInItsWorkspace(t *testing.T) {
	wsID := cockpitFixture(t, "directory-delete-ws-a")
	otherWsID := cockpitFixture(t, "directory-delete-ws-b")

	upsertDirectory(t, wsID, []map[string]any{{"party": "华为", "name": "黄支学"}}).Want(http.StatusOK)

	// The other workspace cannot reach the row even by exact name.
	deleteDirectoryEntry(t, otherWsID, map[string]any{"party": "华为", "name": "黄支学"}).
		Want(http.StatusNotFound)
	if got := dbfx.Count(t, "SELECT COUNT(*) FROM cockpit_directory WHERE workspace_id = $1", wsID); got != 1 {
		t.Fatalf("cross-workspace delete must not touch the row, got %d", got)
	}
}
