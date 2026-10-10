package handler

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func saveStableSnapshot(t *testing.T, ws string) CockpitSnapshotResponse {
	t.Helper()
	var out CockpitSnapshotResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitSnapshot), cockpitRequest(http.MethodPost, "/snapshots", ws, map[string]any{"label": "Fixed plan"})).Want(201).JSON(&out)
	return out
}
func readSnapshotDiff(t *testing.T, ws, id, query string) *testutil.Response {
	t.Helper()
	return testutil.Call(t, cockpitHandler(testHandler.GetCockpitSnapshotDiff), testutil.WithURLParams(cockpitRequest(http.MethodGet, "/snapshots/"+id+"/diff"+query, ws, nil), "snapshotId", id))
}
func TestCockpitSnapshotDiffStableSaveChangesAndStaleCursor(t *testing.T) {
	ws := cockpitFixture(t, "UUID plan history")
	first := createNode(t, ws, map[string]any{"code": "L1-01", "name": "Original"})
	removed := createNode(t, ws, map[string]any{"code": "L1-02", "name": "Deleted"})
	dbfx.Insert(t, "cockpit_payment", testutil.Cols{"workspace_id": ws, "node_id": first.ID, "amount": "12.3456", "label": "Payment"})
	snap := saveStableSnapshot(t, ws)
	var before service.CockpitSnapshotDiff
	readSnapshotDiff(t, ws, snap.ID, "").Want(200).JSON(&before)
	if !before.Comparable || before.Reason != "" || before.Total != 0 || before.Counts.Unchanged != 4 || !before.SnapshotComplete || !before.CurrentComplete {
		t.Fatalf("saved plan not comparable: %+v", before)
	}
	dbfx.Exec(t, "UPDATE cockpit_node SET name='Changed',note=$3 WHERE workspace_id=$1 AND id=$2", ws, first.ID, strings.Repeat("记录", 600))
	dbfx.Exec(t, "DELETE FROM cockpit_node WHERE workspace_id=$1 AND id=$2", ws, removed.ID)
	createNode(t, ws, map[string]any{"code": "L1-03", "name": "Added"})
	var page service.CockpitSnapshotDiff
	readSnapshotDiff(t, ws, snap.ID, "?page_size=1").Want(200).JSON(&page)
	if page.Total != 3 || page.Counts.Added != 1 || page.Counts.Removed != 1 || page.Counts.Modified != 1 || page.NextCursor == nil {
		t.Fatalf("UUID diff counts: %+v", page)
	}
	seen := map[string]bool{}
	cursor := ""
	for {
		readSnapshotDiff(t, ws, snap.ID, "?page_size=1&cursor="+url.QueryEscape(cursor)).Want(200).JSON(&page)
		if len(page.Items) != 1 || seen[page.Items[0].ID] {
			t.Fatal("page lost or repeated identity")
		}
		seen[page.Items[0].ID] = true
		for _, field := range page.Items[0].FieldChanges {
			if field.Field == "note" && !field.After.Truncated {
				t.Fatal("long note leaked full body")
			}
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}
	if len(seen) != 3 {
		t.Fatal("incomplete pagination")
	}
	readSnapshotDiff(t, ws, snap.ID, "?page_size=1").Want(200).JSON(&page)
	cursor = *page.NextCursor
	dbfx.Exec(t, "UPDATE cockpit_node SET owner='New owner' WHERE workspace_id=$1 AND id=$2", ws, first.ID)
	readSnapshotDiff(t, ws, snap.ID, "?page_size=1&cursor="+url.QueryEscape(cursor)).Want(409)
	readSnapshotDiff(t, ws, snap.ID, "?page_size=2&cursor="+url.QueryEscape(cursor)).Want(400)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_snapshot WHERE workspace_id=$1", ws) != 1 {
		t.Fatal("read comparison wrote a snapshot")
	}
}
func TestCockpitSnapshotDiffLegacyAndReplacedBoardAreExplicit(t *testing.T) {
	ws := cockpitFixture(t, "Legacy plan identity")
	createNode(t, ws, map[string]any{"code": "L1-01"})
	snap := saveStableSnapshot(t, ws)
	dbfx.Exec(t, "UPDATE cockpit_snapshot SET payload=payload-'plan_identity' WHERE workspace_id=$1 AND id=$2", ws, snap.ID)
	var out service.CockpitSnapshotDiff
	readSnapshotDiff(t, ws, snap.ID, "").Want(200).JSON(&out)
	if out.Comparable || out.Reason != "legacy_identity_missing" || out.Total != 0 || len(out.Items) != 0 || out.NextCursor != nil {
		t.Fatalf("legacy guessed mapping: %+v", out)
	}
	stable := saveStableSnapshot(t, ws)
	dbfx.Exec(t, "UPDATE cockpit_snapshot SET payload=jsonb_set(payload,'{plan_identity,schema_version}','99') WHERE workspace_id=$1 AND id=$2", ws, stable.ID)
	readSnapshotDiff(t, ws, stable.ID, "").Want(200).JSON(&out)
	if out.Reason != "unsupported_identity_version" {
		t.Fatal(out.Reason)
	}
	dbfx.Exec(t, "UPDATE cockpit_snapshot SET payload=jsonb_set(payload,'{plan_identity,schema_version}','1') WHERE workspace_id=$1 AND id=$2", ws, stable.ID)
	unknown := saveStableSnapshot(t, ws)
	dbfx.Exec(t, `UPDATE cockpit_snapshot SET payload=jsonb_set(payload,'{plan_identity}','"future metadata"') WHERE workspace_id=$1 AND id=$2`, ws, unknown.ID)
	// Comparison metadata is not an import instruction or a restore prerequisite.
	restoreSnapshot(t, ws, unknown.ID).Want(http.StatusOK)
	dbfx.Exec(t, "DELETE FROM cockpit_node WHERE workspace_id=$1", ws)
	dbfx.Exec(t, "DELETE FROM cockpit WHERE workspace_id=$1", ws)
	readSnapshotDiff(t, ws, stable.ID, "").Want(200).JSON(&out)
	if out.Reason != "cockpit_missing" {
		t.Fatal(out.Reason)
	}
	if dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("diff initialized cockpit")
	}
	getBoard(t, ws)
	readSnapshotDiff(t, ws, stable.ID, "").Want(200).JSON(&out)
	if out.Reason != "cockpit_replaced" {
		t.Fatal(out.Reason)
	}
	dbfx.Exec(t, "UPDATE cockpit_snapshot SET payload='[]' WHERE workspace_id=$1 AND id=$2", ws, stable.ID)
	readSnapshotDiff(t, ws, stable.ID, "").Want(200).JSON(&out)
	if out.Reason != "invalid_identity" {
		t.Fatalf("malformed document accepted: %+v", out)
	}
}
func TestCockpitSnapshotDiffScopeAndRestoreProtection(t *testing.T) {
	ws := cockpitFixture(t, "Plan protection")
	project := dbfx.Project(t, "Bound", testutil.Cols{"workspace_id": ws})
	createNode(t, ws, map[string]any{"code": "L1-01", "project_id": project})
	snap := saveStableSnapshot(t, ws)
	readSnapshotDiff(t, ws, snap.ID, "?project_id="+project).Want(400)
	readSnapshotDiff(t, ws, snap.ID, "?page_size=101").Want(400)
	other := cockpitFixture(t, "Other plan")
	readSnapshotDiff(t, other, snap.ID, "").Want(404)
	readSnapshotDiff(t, other, uuid.NewString(), "").Want(404)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1", other) != 0 {
		t.Fatal("missing diff created a board")
	}
	testutil.Call(t, cockpitHandler(testHandler.RestoreCockpitSnapshot), testutil.WithURLParams(cockpitRequest(http.MethodPost, "/restore", ws, nil), "snapshotId", snap.ID)).Want(409)
	dbfx.Exec(t, "UPDATE cockpit_snapshot SET payload=jsonb_set(payload,'{plan_identity,nodes}','[{\"id\":\"L1-01\"}]') WHERE workspace_id=$1 AND id=$2", ws, snap.ID)
	var out service.CockpitSnapshotDiff
	readSnapshotDiff(t, ws, snap.ID, "").Want(200).JSON(&out)
	if out.Reason != "invalid_identity" {
		t.Fatalf("malformed identity accepted: %+v", out)
	}
}
func TestCockpitSnapshotDiffCurrentLimitNeverReturnsPartialPlan(t *testing.T) {
	ws := cockpitFixture(t, "Plan diff cap")
	node := createNode(t, ws, map[string]any{"code": "L1-01"})
	snap := saveStableSnapshot(t, ws)
	dbfx.Exec(t, `INSERT INTO cockpit_node(workspace_id,cockpit_id,code,name) SELECT $1,$2,'limit-'||n,'Extra' FROM generate_series(1,5000) n`, ws, node.CockpitID)
	var failure map[string]json.RawMessage
	readSnapshotDiff(t, ws, snap.ID, "").Want(413).JSON(&failure)
	if string(failure["code"]) != `"snapshot_diff_limit"` {
		t.Fatalf("limit response: %s", failure["code"])
	}
}
