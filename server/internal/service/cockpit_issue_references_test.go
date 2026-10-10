package service

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
)

func TestCockpitIssueReferencesAreBoundedAndDistinctFromPrimary(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	created, err := f.issues.CreateCockpitNodeTask(ctx, f.createInput("Primary with separate references"), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	issue := created.Issue.ID
	missing := uuid.NewString()
	for _, node := range []string{util.UUIDToString(f.a), util.UUIDToString(f.b), missing} {
		f.InsertNoID(t, "cockpit_node_issue", testutil.Cols{"workspace_id": f.ws, "node_id": node, "issue_id": issue}, "workspace_id=$1 AND node_id=$2 AND issue_id=$3", f.ws, node, issue)
	}
	first, err := f.issues.ListCockpitIssueNodeReferences(ctx, f.ws, issue, "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if first.Total != 2 || len(first.Items) != 1 || first.NextCursor == nil {
		t.Fatalf("bounded first page: %+v", first)
	}
	second, err := f.issues.ListCockpitIssueNodeReferences(ctx, f.ws, issue, *first.NextCursor, 1)
	if err != nil {
		t.Fatal(err)
	}
	if second.Total != 2 || len(second.Items) != 1 || second.NextCursor != nil || first.Items[0].NodeID == second.Items[0].NodeID {
		t.Fatalf("bad continuation: %+v", second)
	}
	for _, row := range append(first.Items, second.Items...) {
		if row.NodeID == util.UUIDToString(f.a) || row.Relation != "reference" || !row.CanUnlink {
			t.Fatalf("primary became reference: %+v", row)
		}
		if row.NodeID == missing && (row.Available || row.Title != "") {
			t.Fatalf("orphan fabricated destination: %+v", row)
		}
	}
	if _, err = f.issues.ListCockpitIssueNodeReferences(ctx, f.ws, issue, *first.NextCursor, 25); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("cursor accepted different size: %v", err)
	}
	if _, err = f.issues.ListCockpitIssueMeetingReferences(ctx, f.ws, issue, *first.NextCursor, 1); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("cursor accepted different relation: %v", err)
	}
	outside, _ := newPrincipalFixture(t)
	if _, err = f.issues.ListCockpitIssueNodeReferences(ctx, parseTestUUID(t, outside.WorkspaceID), issue, "", 25); !errors.Is(err, ErrCockpitWorkflowNotFound) {
		t.Fatalf("cross workspace returned issue: %v", err)
	}
}

func TestCockpitIssueMeetingReferencesKeepFormalAndOrphanFacts(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	f.init(t, "")
	work := f.work(t)
	extra := uuid.NewString()
	f.InsertNoID(t, "cockpit_meeting_issue", testutil.Cols{"workspace_id": f.ws, "meeting_id": extra, "issue_id": work.MinutesIssueID, "role": "task", "roles": []string{"preparation"}}, "workspace_id=$1 AND meeting_id=$2 AND issue_id=$3", f.ws, extra, work.MinutesIssueID)
	out, err := f.issues.ListCockpitIssueMeetingReferences(ctx, f.ws, work.MinutesIssueID, "", 25)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Items) != 2 || out.Total != 2 || out.WorkspaceID != util.UUIDToString(f.ws) {
		t.Fatalf("bad reverse page: %+v", out)
	}
	for _, row := range out.Items {
		if row.MeetingID == util.UUIDToString(f.meeting) {
			if !row.Available || row.CanUnlink || len(row.RequiredRoles) != 1 || row.RequiredRoles[0] != "minutes" {
				t.Fatalf("formal relation not protected: %+v", row)
			}
		} else if row.Available || !row.CanUnlink || row.Role != "task" || len(row.Roles) != 1 || row.Roles[0] != "preparation" {
			t.Fatalf("orphan source facts lost: %+v", row)
		}
	}
}

func TestCockpitIssueMeetingReferencesProtectRetiredReviewer(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	before, _ := prepareHandoffPending(t, f)
	target := parseTestUUID(t, f.member(t, "reverse-reviewer"))
	if err := f.issues.ChangeCockpitMeetingReviewer(context.Background(), handoffInput(t, f, target), IssueCreateOpts{}); err != nil {
		t.Fatal(err)
	}
	out, err := f.issues.ListCockpitIssueMeetingReferences(context.Background(), f.ws, before.ReviewIssueID, "", 25)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.issues.RemoveCockpitIssueReference(context.Background(), f.ws, before.ReviewIssueID, f.meeting, f.owner, "meeting"); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("retired formal reference removed: %v", err)
	}
	if out.Total != 1 || len(out.Items) != 1 || out.Items[0].CanUnlink || len(out.Items[0].RequiredRoles) != 1 || out.Items[0].RequiredRoles[0] != "review" {
		t.Fatalf("retired review lost formal relation: %+v", out)
	}
}

func TestCockpitIssueReferenceCleanupIsExplicitAndPreservesPrimaryAndFormalHistory(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	created, err := f.issues.CreateCockpitNodeTask(ctx, f.createInput("Keep ownership"), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	issue := created.Issue.ID
	missing := parseTestUUID(t, uuid.NewString())
	for _, node := range []string{util.UUIDToString(f.a), util.UUIDToString(missing)} {
		f.InsertNoID(t, "cockpit_node_issue", testutil.Cols{"workspace_id": f.ws, "node_id": node, "issue_id": issue}, "workspace_id=$1 AND node_id=$2 AND issue_id=$3", f.ws, node, issue)
	}
	receipt, err := f.issues.RemoveCockpitIssueReference(ctx, f.ws, issue, missing, f.owner, "node")
	if err != nil || !receipt.Removed || receipt.TargetID != util.UUIDToString(missing) {
		t.Fatalf("cleanup missing target: %+v %v", receipt, err)
	}
	if _, err = f.issues.RemoveCockpitIssueReference(ctx, f.ws, issue, missing, f.owner, "node"); !errors.Is(err, ErrCockpitWorkflowNotFound) {
		t.Fatalf("nonexistent reference was acknowledged: %v", err)
	}
	if _, err = f.issues.RemoveCockpitIssueReference(ctx, f.ws, issue, f.a, f.owner, "node"); err != nil {
		t.Fatal(err)
	}
	primary, err := f.issues.GetCockpitIssuePrimaryNode(ctx, f.ws, issue)
	if err != nil || primary.NodeID == nil || *primary.NodeID != util.UUIDToString(f.a) {
		t.Fatalf("reference cleanup moved primary: %+v %v", primary, err)
	}
	if _, err = f.issues.RemoveCockpitIssueReference(ctx, f.ws, f.work(t).MinutesIssueID, f.meeting, f.owner, "meeting"); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("formal source reference was removed: %v", err)
	}
}
