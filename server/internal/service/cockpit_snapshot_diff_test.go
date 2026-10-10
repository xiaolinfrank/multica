package service

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func snapshotPureFixture(t *testing.T) *CockpitPlanSnapshotIdentity {
	t.Helper()
	id := func() pgtype.UUID { return parseTestUUID(t, uuid.NewString()) }
	board := db.Cockpit{ID: id(), WorkspaceID: id(), Title: "Original plan"}
	value, err := BuildCockpitPlanSnapshotIdentity(board, []db.CockpitNode{{ID: id(), WorkspaceID: board.WorkspaceID, CockpitID: board.ID, Code: "L1-01", Name: "Before"}}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	return value
}
func snapshotClone(t *testing.T, value *CockpitPlanSnapshotIdentity) *CockpitPlanSnapshotIdentity {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var copy CockpitPlanSnapshotIdentity
	if err = json.Unmarshal(data, &copy); err != nil {
		t.Fatal(err)
	}
	return &copy
}
func TestCockpitSnapshotIdentityRejectsGuessedOrPartialIdentity(t *testing.T) {
	value := snapshotPureFixture(t)
	if reason := validateSnapshotIdentity(value, value.WorkspaceID, value.CockpitID); reason != "" {
		t.Fatal(reason)
	}
	for _, tc := range []struct {
		name, reason string
		change       func(*CockpitPlanSnapshotIdentity)
	}{
		{"unknown schema", "unsupported_identity_version", func(v *CockpitPlanSnapshotIdentity) { v.SchemaVersion = 2 }},
		{"incomplete", "incomplete_identity", func(v *CockpitPlanSnapshotIdentity) { v.Complete = false }},
		{"code is not UUID", "invalid_identity", func(v *CockpitPlanSnapshotIdentity) { v.Nodes[0].ID = "L1-01" }},
		{"duplicate UUID", "invalid_identity", func(v *CockpitPlanSnapshotIdentity) { v.Nodes = append(v.Nodes, v.Nodes[0]); v.Counts.Nodes++ }},
		{"partial fields", "invalid_identity", func(v *CockpitPlanSnapshotIdentity) { delete(v.Nodes[0].Fields, "name") }},
		{"nested value", "invalid_identity", func(v *CockpitPlanSnapshotIdentity) { v.Nodes[0].Fields["name"] = json.RawMessage(`{"bad":true}`) }},
		{"wrong workspace", "invalid_identity", func(v *CockpitPlanSnapshotIdentity) { v.WorkspaceID = uuid.NewString() }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			copy := snapshotClone(t, value)
			tc.change(copy)
			if got := validateSnapshotIdentity(copy, value.WorkspaceID, value.CockpitID); got != tc.reason {
				t.Fatalf("got %q, want %q", got, tc.reason)
			}
		})
	}
	if validateSnapshotIdentity(nil, value.WorkspaceID, value.CockpitID) != "legacy_identity_missing" {
		t.Fatal("legacy codes gained identity")
	}
}
func TestCockpitSnapshotDiffUsesUUIDAndExactNumbers(t *testing.T) {
	if scalarEqual(json.RawMessage("null"), json.RawMessage(`""`)) || scalarEqual(json.RawMessage(`""`), json.RawMessage("null")) {
		t.Fatal("null and an empty JSON string are different plan values")
	}
	before := snapshotPureFixture(t)
	after := snapshotClone(t, before)
	before.Nodes[0].Fields["budget_amount"] = json.RawMessage("1234567890.1234")
	after.Nodes[0].Fields["budget_amount"] = json.RawMessage("1234567890.123400")
	after.Nodes[0].Fields["name"] = json.RawMessage(`"Renamed"`)
	after.Nodes[0].Name = "Renamed"
	items, counts := compareSnapshotPlans(before, after)
	if counts.Modified != 1 || counts.Unchanged != 1 || len(items) != 1 || len(items[0].FieldChanges) != 1 || items[0].FieldChanges[0].Field != "name" {
		t.Fatalf("rename or numeric identity: %+v %+v", counts, items)
	}
	after.Nodes[0].ID = uuid.NewString()
	items, counts = compareSnapshotPlans(before, after)
	if counts.Added != 1 || counts.Removed != 1 || counts.Modified != 0 {
		t.Fatalf("same code matched unrelated UUIDs: %+v", counts)
	}
	for _, item := range items {
		if len(item.FieldChanges) != 0 {
			t.Fatal("added/removed rows returned document bodies")
		}
	}
}
func TestCockpitSnapshotDiffBoundsTextWithoutChangingEvidenceHash(t *testing.T) {
	raw, _ := json.Marshal(strings.Repeat("议", 600))
	value := snapshotDiffValue(raw)
	var visible string
	_ = json.Unmarshal(value.Value, &visible)
	if !value.Truncated || len([]rune(visible)) != 512 || len(value.SHA256) != 64 || value.SHA256 == snapshotHash(visible) {
		t.Fatalf("unbounded or misleading value: %+v", value)
	}
	short := snapshotDiffValue(json.RawMessage("null"))
	if short.Truncated || string(short.Value) != "null" {
		t.Fatal("null changed meaning")
	}
}
