package service

import (
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestNextCockpitChildCode(t *testing.T) {
	cases := []struct {
		name       string
		parentCode string
		used       []string
		children   int
		want       string
	}{
		{"an empty ledger starts at 01", "02.02", nil, 0, "02.02.01"},
		{"dotted parents continue dotted", "02.02", []string{"02.02.01", "02.02.02"}, 2, "02.02.03"},
		{"a deleted code stays spent", "02.02", []string{"02.02.01", "02.02.05"}, 1, "02.02.06"},
		{"legacy-coded children still occupy visible positions", "01.03",
			[]string{"01.03", "L3-01-33", "L3-01-34", "L3-01-35", "L3-01-36", "L3-01-37"}, 5, "01.03.06"},
		{"hand-edited tails do not join the count", "02.02", []string{"02.02-X", "02.02.01-03"}, 0, "02.02.01"},
		{"an unpadded number is the same number", "02.02", []string{"02.02.1", "02.02.01"}, 0, "02.02.02"},
		{"grandchild codes do not join the count", "02.02", []string{"02.02.01.01"}, 0, "02.02.01"},
		{"counting is numeric, not lexicographic", "AI-03-02", []string{"AI-03-02-9", "AI-03-02-10"}, 0, "AI-03-02-11"},
		{"dashed parents keep the dash", "AI-03-02", nil, 0, "AI-03-02-01"},
		{"dashed parents also step past legacy children", "AI-03-02", nil, 3, "AI-03-02-04"},
		{"a bare module code keeps the dash", "01", nil, 0, "01-01"},
		{"a bare module code does not mint direction-shaped codes", "01", []string{"01.01", "01.02"}, 2, "01-03"},
		{"a task parent mints a fourth segment", "01.03.06", nil, 1, "01.03.06.02"},
		{"other directions do not count", "02.02", []string{"02.03.01", "L1-02-01"}, 0, "02.02.01"},
		{"the prefix must match to the separator", "02.0", []string{"02.02-01"}, 0, "02.0-01"},
		{"a spent dash code does not seed the dotted family", "02.02", []string{"02.02-03"}, 0, "02.02.01"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := nextCockpitChildCode(tc.parentCode, tc.used, tc.children); got != tc.want {
				t.Errorf("nextCockpitChildCode(%q, %v, %d) = %q, want %q", tc.parentCode, tc.used, tc.children, got, tc.want)
			}
		})
	}
}

func TestLiveChildFloor(t *testing.T) {
	parentID := pgtype.UUID{Bytes: [16]byte{1}, Valid: true}
	otherID := pgtype.UUID{Bytes: [16]byte{2}, Valid: true}
	child := func(id byte, parent pgtype.UUID, code string, position float64) db.CockpitNode {
		return db.CockpitNode{
			ID:       pgtype.UUID{Bytes: [16]byte{id}, Valid: true},
			ParentID: parent,
			Code:     code,
			Position: position,
		}
	}
	cases := []struct {
		name  string
		nodes []db.CockpitNode
		want  int
	}{
		{"no children", nil, 0},
		{"plain children all count", []db.CockpitNode{
			child(1, parentID, "L3-01-33", 1), child(2, parentID, "L3-01-34", 2),
		}, 2},
		{"a first-child governance row occupies no number", []db.CockpitNode{
			child(1, parentID, "01.03.00", 1), child(2, parentID, "01.03.01", 2), child(3, parentID, "01.03.02", 3),
		}, 2},
		{"a governance code off the front counts normally", []db.CockpitNode{
			child(1, parentID, "01.03.01", 1), child(2, parentID, "01.03.00", 2),
		}, 2},
		{"other parents and roots do not count", []db.CockpitNode{
			child(1, parentID, "01.03.01", 1),
			child(2, otherID, "01.03.02", 1),
			{ID: pgtype.UUID{Bytes: [16]byte{9}, Valid: true}, Code: "01.03"},
		}, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := liveChildFloor(tc.nodes, parentID); got != tc.want {
				t.Errorf("liveChildFloor = %d, want %d", got, tc.want)
			}
		})
	}
}
