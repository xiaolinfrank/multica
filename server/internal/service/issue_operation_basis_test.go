package service

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestIssueOperationBasisFormalAndOrdinaryBoundaries(t *testing.T) {
	f := newArtifactFixture(t)
	ctx := context.Background()
	version, err := f.issues.SubmitCockpitArtifactVersion(ctx, f.submission(t, "Fixed formal evidence"), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	v, err := f.q.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: f.ws, ArtifactID: f.artifact, ID: version})
	if err != nil {
		t.Fatal(err)
	}
	ordinary, err := f.issues.CreateCockpitNodeTask(ctx, f.createInput("Ordinary owned task"), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	missing := dbid.NewV7()
	ids := []pgtype.UUID{ordinary.Issue.ID, missing, v.ReviewIssueID, f.producer, f.version.ReviewIssueID}
	read := func() IssueOperationBasisPage {
		t.Helper()
		p, e := f.issues.ListIssueOperationBasis(ctx, IssueOperationBasisQuery{WorkspaceID: f.ws, ActorID: f.owner, Human: true, IssueIDs: ids})
		if e != nil {
			t.Fatal(e)
		}
		return p
	}
	p := read()
	if len(p.Items) != len(ids) {
		t.Fatal("read lost requested IDs")
	}
	for i, id := range ids {
		if p.Items[i].IssueID != util.UUIDToString(id) {
			t.Fatal("read reordered requested IDs")
		}
	}
	if p.Items[0].Scope.State != "blocked" || p.Items[0].Delete.State != "allowed" || p.Items[0].Primary.State != "allowed" {
		t.Fatalf("ordinary primary confused with retained source: %+v", p.Items[0])
	}
	if p.Items[1].Availability != "unavailable" || p.Items[1].Status.State != "unknown" || len(p.Items[1].Status.AllowedCategories) != 0 || p.Items[1].TargetsTotal != 0 {
		t.Fatalf("missing target leaked/unlocked: %+v", p.Items[1])
	}
	formal := p.Items[2]
	if !reflect.DeepEqual(formal.Status.AllowedCategories, []string{"unstarted", "started"}) || formal.Assignee.State != "blocked" || formal.Delete.State != "blocked" || formal.Primary.State != "blocked" || formal.Execution.State != "blocked" {
		t.Fatalf("formal pending gates missing: %+v", formal)
	}
	if len(formal.Targets) == 0 || formal.Targets[0].Kind != "artifact_version" || formal.Targets[0].VersionID != util.UUIDToString(v.ID) {
		t.Fatalf("formal target is not fixed: %+v", formal.Targets)
	}
	if p.Items[3].Delete.State != "blocked" || p.Items[3].Scope.ReasonCodes[0] != "retained_artifact_scope" || p.Items[3].Primary.State != "allowed" {
		t.Fatalf("source retained scope confused with primary mutation: %+v", p.Items[3])
	}
	directSource := false
	for _, target := range p.Items[3].Targets {
		if target.Kind == "artifact" && target.ArtifactID == util.UUIDToString(f.artifact) && target.VersionID == "" {
			directSource = true
		}
	}
	if !directSource {
		t.Fatalf("source artifact label opened an unfiltered L3 instead of its exact object: %+v", p.Items[3].Targets)
	}
	minutes := p.Items[4]
	if minutes.Assignee.State != "allowed" || len(minutes.Status.AllowedCategories) != 4 || minutes.Execution.State != "blocked" || minutes.Delete.State != "blocked" {
		t.Fatalf("meeting review acquired different formal constraints: %+v", minutes)
	}
	f.review(t, v.ID, "changes_requested")
	if got := read().Items[2].Status.AllowedCategories; !reflect.DeepEqual(got, []string{"done"}) {
		t.Fatalf("decided formal task reopened: %v", got)
	}
}

func TestIssueOperationBasisDescendantTriageAndContainerGuards(t *testing.T) {
	f := newArtifactFixture(t)
	ctx := context.Background()
	parent := parseTestUUID(t, f.Issue(t, "Parent retains descendant scope", testutil.Cols{"project_id": f.project, "module_id": f.module}))
	f.Exec(t, "UPDATE issue SET parent_issue_id=$1 WHERE id=$2", parent, f.producer)
	triage := parseTestUUID(t, f.Issue(t, "Triage proposal", testutil.Cols{"triage_state": "pending"}))
	child := parseTestUUID(t, f.Issue(t, "Ordinary detachable child", testutil.Cols{"parent_issue_id": parent, "project_id": f.project, "module_id": f.module}))
	p, e := f.issues.ListIssueOperationBasis(ctx, IssueOperationBasisQuery{WorkspaceID: f.ws, ActorID: f.owner, Human: true, IssueIDs: []pgtype.UUID{parent, triage, child}})
	if e != nil {
		t.Fatal(e)
	}
	if p.Items[0].Scope.State != "blocked" || p.Items[0].Delete.State != "allowed" {
		t.Fatalf("descendant retention broadened to parent delete: %+v", p.Items[0])
	}
	if p.Items[1].Parent.State != "blocked" || p.Items[1].Status.State != "allowed" || p.Items[1].Assignee.State != "allowed" || p.Items[1].Execution.State != "blocked" {
		t.Fatalf("triage proposal semantics changed: %+v", p.Items[1])
	}
	if p.Items[2].Scope.State != "allowed" || !reflect.DeepEqual(p.Items[2].Scope.ReasonCodes, []string{"parent_scope_requires_detach"}) {
		t.Fatalf("explicit parent-detach recovery disabled: %+v", p.Items[2])
	}
	for _, c := range []struct {
		kind string
		id   pgtype.UUID
	}{{"node", f.a}, {"node", f.grouping}, {"project", f.project}, {"module", f.module}} {
		b, err := f.issues.GetContainerOperationBasis(ctx, ContainerOperationBasisQuery{WorkspaceID: f.ws, ActorID: f.owner, Human: true, ResourceID: c.id, ResourceKind: c.kind})
		if err != nil {
			t.Fatal(err)
		}
		if b.Delete.State != "blocked" || len(b.Targets) == 0 || b.TargetsTotal < 1 {
			t.Fatalf("%s missing retained deletion context: %+v", c.kind, b)
		}
		if c.kind == "node" && b.StructuralEdit.State != "blocked" {
			t.Fatalf("retained subtree editable: %+v", b)
		}
		if c.id == f.a && b.AddChild.State != "blocked" {
			t.Fatal("retained execution leaf can become grouping node")
		}
	}
	empty, e := f.issues.GetContainerOperationBasis(ctx, ContainerOperationBasisQuery{WorkspaceID: f.ws, ActorID: f.owner, ResourceID: dbid.NewV7(), ResourceKind: "node"})
	if e != nil || empty.Availability != "unavailable" || empty.Delete.State != "unknown" {
		t.Fatalf("missing node unlocked: %+v %v", empty, e)
	}
}

func TestIssueOperationBasisUnknownWireIsExplicit(t *testing.T) {
	basis := unknownIssueOperationBasis("missing", "unavailable")
	raw, err := json.Marshal(basis)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err = json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"status", "assignee", "scope", "parent", "primary", "delete", "execution"} {
		f, ok := fields[name].(map[string]any)
		if !ok || f["state"] != "unknown" {
			t.Fatalf("%s missing explicit unknown: %s", name, raw)
		}
	}
	if fields["issue_revision"] != nil || fields["targets"] == nil {
		t.Fatalf("unknown data presented as an empty allowed record: %s", raw)
	}
}
