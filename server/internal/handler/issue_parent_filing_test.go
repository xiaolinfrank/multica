package handler

import (
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/util"
)

func testPGUUID(t *testing.T) pgtype.UUID {
	t.Helper()
	u, err := util.ParseUUID(uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestCheckBatchParentFilingConflicts(t *testing.T) {
	projA, projB := testPGUUID(t), testPGUUID(t)
	modA, modB := testPGUUID(t), testPGUUID(t)
	wiA, wiB := testPGUUID(t), testPGUUID(t)

	scopeA := issueFilingTarget{ProjectID: projA, ModuleID: modA, WorkItemID: wiA}
	scopeSiblingWI := issueFilingTarget{ProjectID: projA, ModuleID: modA, WorkItemID: wiB}
	scopeB := issueFilingTarget{ProjectID: projB, ModuleID: modB}

	grandparentID := testPGUUID(t)
	parentID := testPGUUID(t)
	childID := testPGUUID(t)
	standaloneID := testPGUUID(t)

	lookup := map[pgtype.UUID]struct {
		parent pgtype.UUID
		filing issueFilingTarget
	}{
		grandparentID: {filing: scopeA},
		parentID:      {parent: grandparentID, filing: scopeA},
		childID:       {parent: parentID, filing: scopeA},
		standaloneID:  {filing: scopeA},
	}
	lookupFn := func(id pgtype.UUID) (pgtype.UUID, issueFilingTarget, bool, error) {
		row, ok := lookup[id]
		return row.parent, row.filing, ok, nil
	}

	t.Run("child moving without parent reports module mismatch", func(t *testing.T) {
		conflicts, err := checkBatchParentFilingConflicts([]batchParentFilingIssue{
			{ID: standaloneID, Current: scopeA, Target: scopeB},
			{ID: childID, ParentIssueID: parentID, Current: scopeA, Target: scopeB},
		}, lookupFn)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(conflicts) != 1 {
			t.Fatalf("conflicts = %+v, want 1", conflicts)
		}
		if conflicts[0].IssueID != util.UUIDToString(childID) ||
			conflicts[0].ParentIssueID != util.UUIDToString(parentID) ||
			conflicts[0].Code != errCodeChildModuleMismatch {
			t.Fatalf("unexpected conflict: %+v", conflicts[0])
		}
	})

	t.Run("child moving to sibling work item without parent reports work_item mismatch", func(t *testing.T) {
		conflicts, err := checkBatchParentFilingConflicts([]batchParentFilingIssue{
			{ID: childID, ParentIssueID: parentID, Current: scopeA, Target: scopeSiblingWI},
		}, lookupFn)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(conflicts) != 1 || conflicts[0].Code != errCodeChildWorkItemMismatch {
			t.Fatalf("conflicts = %+v, want 1 %s", conflicts, errCodeChildWorkItemMismatch)
		}
	})

	t.Run("parent and child moving together in same batch succeeds", func(t *testing.T) {
		// Parent has no unselected ancestor in this sub-test.
		localLookup := func(id pgtype.UUID) (pgtype.UUID, issueFilingTarget, bool, error) {
			if id == parentID {
				return pgtype.UUID{}, scopeA, true, nil
			}
			return lookupFn(id)
		}
		conflicts, err := checkBatchParentFilingConflicts([]batchParentFilingIssue{
			{ID: childID, ParentIssueID: parentID, Current: scopeA, Target: scopeB},
			{ID: parentID, Current: scopeA, Target: scopeB},
		}, localLookup)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(conflicts) != 0 {
			t.Fatalf("conflicts = %+v, want 0", conflicts)
		}
	})

	t.Run("grandparent and grandchild moving together carries middle parent cleanly", func(t *testing.T) {
		conflicts, err := checkBatchParentFilingConflicts([]batchParentFilingIssue{
			{ID: childID, ParentIssueID: parentID, Current: scopeA, Target: scopeB},
			{ID: grandparentID, Current: scopeA, Target: scopeB},
		}, lookupFn)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(conflicts) != 0 {
			t.Fatalf("conflicts = %+v, want 0", conflicts)
		}
	})

	t.Run("child and parent without unselected grandparent flags parent", func(t *testing.T) {
		conflicts, err := checkBatchParentFilingConflicts([]batchParentFilingIssue{
			{ID: childID, ParentIssueID: parentID, Current: scopeA, Target: scopeB},
			{ID: parentID, ParentIssueID: grandparentID, Current: scopeA, Target: scopeB},
		}, lookupFn)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(conflicts) != 1 || conflicts[0].IssueID != util.UUIDToString(parentID) || conflicts[0].ParentIssueID != util.UUIDToString(grandparentID) {
			t.Fatalf("conflicts = %+v, want parent->grandparent conflict", conflicts)
		}
	})

	t.Run("legacy misaligned child realigning to parent's scope is allowed", func(t *testing.T) {
		conflicts, err := checkBatchParentFilingConflicts([]batchParentFilingIssue{
			{ID: childID, ParentIssueID: parentID, Current: scopeB, Target: scopeA},
		}, lookupFn)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(conflicts) != 0 {
			t.Fatalf("conflicts = %+v, want 0", conflicts)
		}
	})
}

func TestOrderBatchIssueIDsParentsFirst(t *testing.T) {
	grandparentID := testPGUUID(t)
	parentID := testPGUUID(t)
	childID := testPGUUID(t)
	otherID := testPGUUID(t)

	gpStr := util.UUIDToString(grandparentID)
	pStr := util.UUIDToString(parentID)
	cStr := util.UUIDToString(childID)
	oStr := util.UUIDToString(otherID)

	items := []batchParentFilingIssue{
		{ID: childID, ParentIssueID: parentID},
		{ID: otherID},
		{ID: parentID, ParentIssueID: grandparentID},
		{ID: grandparentID},
	}
	ordered := orderBatchIssueIDsParentsFirst(
		[]string{cStr, oStr, pStr, gpStr},
		items,
		func(pgtype.UUID) (pgtype.UUID, bool) { return pgtype.UUID{}, false },
	)

	indexOf := func(target string) int {
		for i, id := range ordered {
			if id == target {
				return i
			}
		}
		return -1
	}
	if !(indexOf(gpStr) < indexOf(pStr) && indexOf(pStr) < indexOf(cStr)) {
		t.Fatalf("ordered = %v, want grandparent (%s) < parent (%s) < child (%s)", ordered, gpStr, pStr, cStr)
	}
	if indexOf(oStr) > indexOf(gpStr) {
		t.Fatalf("expected stable relative order for depth-0 items (%s before %s), got %v", oStr, gpStr, ordered)
	}
}
