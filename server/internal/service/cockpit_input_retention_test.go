package service

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestCockpitInputHistoryBlocksDeleteWithoutChangingOrdinaryTaskFields(t *testing.T) {
	f, s, p := inputWriteFixture(t)
	ctx := context.Background()
	issue := parseTestUUID(t, f.Issue(t, "Task with historical input selection"))
	manifest := dbid.NewV7()
	f.Insert(t, "cockpit_issue_input_manifest_version", testutil.Cols{"id": manifest, "workspace_id": p.WorkspaceID, "issue_id": issue, "version_number": 1, "command_key": dbid.NewV7(), "request_hash": strings.Repeat("a", 64), "receipt": testutil.Raw("'{}'::jsonb"), "manifest_hash": strings.Repeat("b", 64), "item_total": 0, "required_total": 0, "created_by": p.CredentialOwnerID})
	query := IssueOperationBasisQuery{WorkspaceID: p.WorkspaceID, ActorID: p.CredentialOwnerID, Human: true, IssueIDs: []pgtype.UUID{issue}}
	before, err := s.ListIssueOperationBasis(ctx, query)
	if err != nil || before.Items[0].Delete.State != "allowed" {
		t.Fatalf("unused saved manifest falsely protected deletion: %+v %v", before, err)
	}
	runtime := f.Runtime(t, "Input history runtime", testutil.Cols{"owner_id": p.CredentialOwnerID})
	agent := f.Agent(t, "Input history agent", runtime, testutil.Cols{"owner_id": p.CredentialOwnerID})
	f.Task(t, agent, testutil.Cols{"issue_id": issue, "runtime_id": runtime, "status": "queued", "input_manifest_version_id": manifest, "input_preparation_state": "pending"})
	after, err := s.ListIssueOperationBasis(ctx, query)
	if err != nil || after.Items[0].Delete.State != "blocked" || after.Items[0].Delete.ReasonCodes[0] != "retained_input_history" {
		t.Fatalf("retained Run pin not visible to deletion UI: %+v %v", after, err)
	}
	row := after.Items[0]
	if row.Assignee.State != "allowed" || row.Execution.State != "allowed" || row.Status.State != "allowed" {
		t.Fatalf("historical provenance blocked unrelated actions: %+v", row)
	}
	found := false
	for _, target := range row.Targets {
		if target.Kind == "issue" && target.IssueID == util.UUIDToString(issue) && target.VersionID == util.UUIDToString(manifest) && target.View == "inputs" && target.Purpose == "input_manifest" {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing exact historical-manifest repair route: %+v", row.Targets)
	}
}
func TestCockpitMeetingInputDeleteBasisFollowsExactActiveReferences(t *testing.T) {
	f, p, _, version := inputReferenceFixture(t)
	ctx := context.Background()
	query := CockpitInputQuery{CockpitInputRead: p, MeetingID: f.meeting}
	ref, err := f.issues.CreateCockpitInputReference(ctx, query, CockpitInputReferenceCreateInput{CommandKey: util.UUIDToString(dbid.NewV7()), InputVersionID: util.UUIDToString(version), Purpose: "material"})
	if err != nil {
		t.Fatal(err)
	}
	basis, err := f.issues.GetCockpitMeetingOperationBasis(ctx, lifecycleRead(f))
	if err != nil || basis.Delete.State != "blocked" || basis.Delete.ReasonCodes[0] != "meeting_input_references" {
		t.Fatalf("active input missing from deletion basis: %+v %v", basis, err)
	}
	found := false
	for _, target := range basis.Targets {
		if target.MeetingID == util.UUIDToString(f.meeting) && target.View == "resources" && target.Purpose == "meeting_input_references" {
			found = true
		}
	}
	if !found {
		t.Fatal("meeting deletion has no direct materials route")
	}
	query.ReferenceID = parseTestUUID(t, ref.Receipt.ReferenceID)
	if _, err = f.issues.RemoveCockpitInputReference(ctx, query, CockpitInputReferenceRemoveInput{CommandKey: util.UUIDToString(dbid.NewV7())}); err != nil {
		t.Fatal(err)
	}
	after, err := f.issues.GetCockpitMeetingOperationBasis(ctx, lifecycleRead(f))
	if err != nil || after.Delete.State != "allowed" {
		t.Fatalf("removed reference still prevented deletion: %+v %v", after, err)
	}
}
