package service

import (
	"context"
	"io"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestCockpitInputBorrowsPendingFixedTextWithoutCopyOrReview(t *testing.T) {
	f := newArtifactFixture(t)
	ctx := context.Background()
	text := "  preserved original text\n"
	artifactVersion, err := f.issues.SubmitCockpitArtifactVersion(ctx, f.submission(t, text), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	p := CockpitInputRead{WorkspaceID: f.ws, CredentialOwnerID: f.owner, ActorSource: "human"}
	// Text borrowing needs no object provider, but still uses the common bounded
	// reader lifetime and never claims file capture is configured.
	f.issues.ConfigureCockpitInputStorage(nil)
	head, err := f.issues.CreateCockpitInput(ctx, p, CockpitInputCreateInput{CommandKey: util.UUIDToString(dbid.NewV7()), Title: "Discussion source"})
	if err != nil {
		t.Fatal(err)
	}
	f.Cleanup(t, "DELETE FROM cockpit_input WHERE workspace_id=$1", f.ws)
	f.Cleanup(t, "DELETE FROM cockpit_input_version WHERE workspace_id=$1", f.ws)
	q := CockpitInputQuery{CockpitInputRead: p, InputID: inputTrustedID(head.Receipt.InputID)}
	sub, err := f.issues.SubmitCockpitInputVersion(ctx, q, CockpitInputVersionSubmitInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: 1, Source: CockpitInputSourceInput{Kind: "artifact_version", ArtifactVersion: &CockpitInputArtifactSource{ArtifactID: util.UUIDToString(f.artifact), VersionID: util.UUIDToString(artifactVersion)}}})
	if err != nil || sub.Receipt.TransferID != nil || sub.Transfer != nil || sub.Current == nil || sub.Current.Source.ArtifactDecision == nil || *sub.Current.Source.ArtifactDecision != "pending" {
		t.Fatalf("borrow pending fixed text: %+v %v", sub, err)
	}
	q.VersionID = inputTrustedID(sub.Receipt.VersionID)
	_, r, err := f.issues.OpenCockpitInputFile(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	body, e := io.ReadAll(r)
	closeErr := r.Close()
	if e != nil || closeErr != nil || string(body) != text {
		t.Fatalf("original exact text: %q %v %v", body, e, closeErr)
	}
	var transfers, reviews int
	if err = f.Pool.QueryRow(ctx, "SELECT count(*) FROM cockpit_input_transfer WHERE workspace_id=$1", f.ws).Scan(&transfers); err != nil {
		t.Fatal(err)
	}
	if err = f.Pool.QueryRow(ctx, "SELECT count(*) FROM cockpit_artifact_version WHERE workspace_id=$1 AND review_issue_id IS NOT NULL", f.ws).Scan(&reviews); err != nil {
		t.Fatal(err)
	}
	if transfers != 0 || reviews != 1 {
		t.Fatalf("borrowing created new capture/review: %d/%d", transfers, reviews)
	}
	if _, err = f.Pool.Exec(ctx, "DELETE FROM cockpit_artifact_version WHERE workspace_id=$1 AND id=$2", f.ws, artifactVersion); err == nil {
		t.Fatal("borrowed source deleted despite fixed input history")
	}
}

func TestCockpitArtifactExplicitInputManifestKeepsCrossIssueProvenance(t *testing.T) {
	f := newArtifactFixture(t)
	ctx := context.Background()
	sourceIssue := parseTestUUID(t, f.Issue(t, "Original collection task"))
	// The generic fixture inserts its numbered Issue directly; synchronize the
	// allocator before the real canonical Review Issue is created below.
	if _,err:=f.Pool.Exec(ctx,"UPDATE workspace SET issue_counter=GREATEST(issue_counter,(SELECT COALESCE(max(number),0) FROM issue WHERE workspace_id=$1)) WHERE id=$1",f.ws);err!=nil{t.Fatal(err)}
	manifest := dbid.NewV7()
	f.Insert(t, "cockpit_issue_input_manifest_version", testutil.Cols{"id": manifest, "workspace_id": f.ws, "issue_id": sourceIssue, "version_number": 3, "command_key": dbid.NewV7(), "request_hash": strings.Repeat("a", 64), "receipt": testutil.Raw("'{}'::jsonb"), "manifest_hash": strings.Repeat("b", 64), "item_total": 0, "required_total": 0, "created_by": f.owner})
	// Artifact teardown must precede the fixture manifest/Issue cleanup because
	// this test deliberately creates a retained provenance edge to that Issue.
	t.Cleanup(func() {
		if err := f.q.DeleteCockpitArtifactsByWorkspace(ctx, f.ws); err != nil {
			t.Error(err)
		}
	})
	in := f.submission(t, "Output from explicitly selected source inputs")
	in.InputManifestVersionID = manifest
	id, err := f.issues.SubmitCockpitArtifactVersion(ctx, in, IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	detail, err := f.issues.GetCockpitArtifactVersion(ctx, CockpitArtifactRead{WorkspaceID: f.ws, ArtifactID: f.artifact, VersionID: id, ActorID: f.owner, Human: true})
	if err != nil || detail.Version.InputManifestVersionID == nil || *detail.Version.InputManifestVersionID != util.UUIDToString(manifest) || detail.Version.InputManifestIssueID == nil || *detail.Version.InputManifestIssueID != util.UUIDToString(sourceIssue) || detail.Version.InputManifestVersionNumber == nil || *detail.Version.InputManifestVersionNumber != 3 {
		t.Fatalf("precise cross-Issue input provenance: %+v %v", detail.Version, err)
	}
	if _, err = f.issues.SubmitCockpitArtifactVersion(ctx, in, IssueCreateOpts{}); err != nil {
		t.Fatalf("exact original command replay: %v", err)
	}
	row, err := f.q.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: f.ws, ArtifactID: f.artifact, ID: id})
	if err != nil || row.InputManifestVersionID != manifest {
		t.Fatalf("fixed source pointer: %+v %v", row, err)
	}
	_, err = f.Pool.Exec(ctx, "UPDATE cockpit_artifact_version SET input_manifest_version_id=$3 WHERE workspace_id=$1 AND id=$2", f.ws, id, pgtype.UUID{})
	if err == nil {
		t.Fatal("immutable output source could be erased")
	}
}
