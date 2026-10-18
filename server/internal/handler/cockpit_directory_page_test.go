package handler

import (
	"fmt"
	"github.com/multica-ai/multica/server/internal/testutil"
	"net/url"
	"strings"
	"testing"
)

func directoryPage(t *testing.T, ws, path string) CockpitDirectoryPage {
	t.Helper()
	var out CockpitDirectoryPage
	testutil.Call(t, cockpitHandler(testHandler.ListCockpitDirectoryPage), cockpitRequest("GET", "/api/cockpit/directory/page"+path, ws, nil)).Want(200).JSON(&out)
	return out
}
func directoryCompactSave(t *testing.T, ws string, body map[string]any) *testutil.Response {
	t.Helper()
	return testutil.Call(t, cockpitHandler(testHandler.UpsertCockpitDirectory), cockpitRequest("PUT", "/api/cockpit/directory?response=compact", ws, body))
}
func TestCockpitDirectoryPageReadDoesNotCreateAndRejectsFalseScope(t *testing.T) {
	ws := cockpitFixture(t, "Directory read no initialize")
	page := directoryPage(t, ws, "")
	if page.WorkspaceID != ws || page.Scope != "workspace" || page.Party != nil || page.Parties != nil || len(page.Items) != 0 || page.Total != 0 {
		t.Fatalf("invalid empty scope: %+v", page)
	}
	if dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("directory read initialized board")
	}
	for _, query := range []string{"?project_id=", "?module_id=", "?project=ignored", "?party=A&parties=B", "?party=A&party=B", "?page_size=101", "?q=" + strings.Repeat("x", 201), "?" + strings.Repeat("parties=A&", 21)} {
		testutil.Call(t, cockpitHandler(testHandler.ListCockpitDirectoryPage), cockpitRequest("GET", "/page"+query, ws, nil)).Want(400)
	}
}
func TestCockpitDirectoryPageNaturalKeysSearchAndCursorScope(t *testing.T) {
	ws, other := cockpitFixture(t, "Directory pages"), cockpitFixture(t, "Other directory")
	entries := make([]map[string]any, 0, 33)
	for i := 0; i < 31; i++ {
		entries = append(entries, map[string]any{"party": "Research", "name": fmt.Sprintf("Contact %02d", i), "position": "Scientist"})
	}
	entries = append(entries, map[string]any{"party": "Clinical", "name": "Contact 00"}, map[string]any{"party": "", "name": "Unfiled"})
	directoryCompactSave(t, ws, map[string]any{"entries": entries}).Want(200)
	first := directoryPage(t, ws, "?party=Research")
	if first.Total != 31 || len(first.Items) != 25 || first.NextCursor == nil {
		t.Fatalf("page1 %+v", first)
	}
	second := directoryPage(t, ws, "?party=Research&cursor="+url.QueryEscape(*first.NextCursor))
	if second.Total != 31 || len(second.Items) != 6 || second.NextCursor != nil || first.Items[24].Name >= second.Items[0].Name {
		t.Fatalf("continuation %+v", second)
	}
	for _, suffix := range []string{"?party=Clinical", "?party=Research&page_size=10", "?party=Research&q=Scientist"} {
		testutil.Call(t, cockpitHandler(testHandler.ListCockpitDirectoryPage), cockpitRequest("GET", "/page"+suffix+"&cursor="+url.QueryEscape(*first.NextCursor), ws, nil)).Want(400)
	}
	testutil.Call(t, cockpitHandler(testHandler.ListCockpitDirectoryPage), cockpitRequest("GET", "/page?party=Research&cursor="+url.QueryEscape(*first.NextCursor), other, nil)).Want(400)
	multi := directoryPage(t, ws, "?parties=Research&parties=Clinical&parties=Research&q=Contact+00")
	if multi.Total != 2 || len(multi.Parties) != 2 || multi.Parties[0] != "Clinical" || len(multi.Items) != 2 {
		t.Fatalf("multi-party OR %+v", multi)
	}
	empty := directoryPage(t, ws, "?party=")
	if empty.Total != 1 || empty.Party == nil || *empty.Party != "" || empty.Items[0].Name != "Unfiled" {
		t.Fatal("empty party lost")
	}
	if directoryPage(t, other, "").Total != 0 {
		t.Fatal("cross-workspace directory leaked")
	}
}
func TestCockpitDirectoryCompactAcknowledgesFinalRowsAndExplicitClear(t *testing.T) {
	ws := cockpitFixture(t, "Directory exact writes")
	var saved CockpitDirectoryCompactReceipt
	directoryCompactSave(t, ws, map[string]any{"entries": []map[string]any{{"party": " A ", "name": " Contact ", "position": "Lead"}, {"party": "A", "name": "Contact", "position": ""}, {"party": "B", "name": "Other"}}}).Want(200).JSON(&saved)
	if saved.Scope != "workspace" || saved.Action != "upserted" || saved.WorkspaceID != ws || len(saved.Entries) != 2 || saved.Entries[0].Position != "Lead" {
		t.Fatalf("missing final deduplicated receipt %+v", saved)
	}
	directoryCompactSave(t, ws, map[string]any{"entries": []map[string]any{{"party": "A", "name": "Contact", "clear_position": true, "position": "Conflicting"}}}).Want(400)
	directoryCompactSave(t, ws, map[string]any{"entries": []map[string]any{{"party": "A", "name": "Contact", "clear_position": true}}}).Want(200).JSON(&saved)
	if len(saved.Entries) != 1 || saved.Entries[0].Position != "" || directoryPage(t, ws, "?party=A").Items[0].Position != "" {
		t.Fatal("explicit clear not persisted")
	}
	directoryCompactSave(t, ws, map[string]any{"only_unknown_names": true, "entries": []map[string]any{{"party": "B", "name": "Contact"}, {"party": "B", "name": "New", "position": "First"}, {"party": "B", "name": "New", "position": "Final"}}}).Want(200).JSON(&saved)
	if len(saved.Entries) != 1 || saved.Entries[0].Name != "New" || saved.Entries[0].Position != "Final" || len(saved.Skipped) != 1 || saved.Skipped[0].Name != "Contact" || directoryPage(t, ws, "").Total != 3 {
		t.Fatalf("auto-file guessed existing name attribution %+v", saved)
	}
	var deleted CockpitDirectoryCompactReceipt
	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitDirectoryEntry), cockpitRequest("DELETE", "/directory?response=compact", ws, map[string]any{"party": "B", "name": "New"})).Want(200).JSON(&deleted)
	if deleted.Action != "deleted" || len(deleted.Deleted) != 1 || deleted.Deleted[0].Name != "New" || len(deleted.Entries) != 0 {
		t.Fatalf("delete ack %+v", deleted)
	}
	if _, err := testPool.Exec(t.Context(), "UPDATE cockpit_directory SET source='seed' WHERE workspace_id=$1 AND party='A'", ws); err != nil {
		t.Fatal(err)
	}
	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitDirectoryEntry), cockpitRequest("DELETE", "/directory?response=compact", ws, map[string]any{"party": "A", "name": "Contact"})).Want(400)
	if directoryPage(t, ws, "").Total != 2 {
		t.Fatal("protected contact deleted")
	}
}
