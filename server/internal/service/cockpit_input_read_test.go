package service

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestCockpitInputReadCursorCannotCrossIdentityFilterOrPage(t *testing.T) {
	p := CockpitInputQuery{CockpitInputRead: CockpitInputRead{WorkspaceID: dbid.NewV7(), CredentialOwnerID: dbid.NewV7(), ActorSource: "human"}, InputID: dbid.NewV7(), PageSize: 25, Scope: CockpitInputScope{Query: "materials", Archive: "active"}}
	p.Cursor = *inputTimeCursor(p, "inputs", dbid.NewV7(), pgtype.Timestamptz{Time: time.Now(), Valid: true})
	if _, _, err := inputDatedCursor(p, "inputs"); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*CockpitInputQuery){func(q *CockpitInputQuery) { q.WorkspaceID = dbid.NewV7() }, func(q *CockpitInputQuery) { q.CredentialOwnerID = dbid.NewV7() }, func(q *CockpitInputQuery) { q.Scope.Query = "another" }, func(q *CockpitInputQuery) { q.PageSize = 100 }, func(q *CockpitInputQuery) { q.IncludeRemoved = true }} {
		copy := p
		change(&copy)
		if _, _, err := inputDatedCursor(copy, "inputs"); !errors.Is(err, ErrCockpitWorkflowInput) {
			t.Fatalf("cursor crossed its original scope: %v", err)
		}
	}
	p.Cursor = *inputNumberCursor(p, "inputs", dbid.NewV7(), 2)
	if _, _, err := inputDatedCursor(p, "inputs"); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("number cursor accepted for dated page: %v", err)
	}
	p.Cursor = *inputNumberCursor(p, "versions", dbid.NewV7(), 1<<32)
	if _, err := inputSequenceCursor(p, "versions"); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("overflow sequence cursor: %v", err)
	}
}
func TestCockpitInputReadCatalogPagesStableAfterNewRegistrationAndLiteralPrefix(t *testing.T) {
	_, s, p := inputWriteFixture(t)
	ctx := context.Background()
	originals := map[string]bool{}
	for i := 0; i < 28; i++ {
		r, err := s.CreateCockpitInput(ctx, p, CockpitInputCreateInput{CommandKey: util.UUIDToString(dbid.NewV7()), Title: fmt.Sprintf("100%%_material %02d", i)})
		if err != nil {
			t.Fatal(err)
		}
		originals[r.Receipt.InputID] = true
	}
	if _, err := s.CreateCockpitInput(ctx, p, CockpitInputCreateInput{CommandKey: util.UUIDToString(dbid.NewV7()), Title: "100XAmaterial wildcard decoy"}); err != nil {
		t.Fatal(err)
	}
	query := CockpitInputQuery{CockpitInputRead: p, PageSize: 25, Scope: CockpitInputScope{Query: "100%_material"}}
	first, err := s.ListCockpitInputs(ctx, query)
	if err != nil || first.Total != 28 || len(first.Items) != 25 || first.NextCursor == nil {
		t.Fatalf("first bounded literal-prefix page: %+v %v", first, err)
	}
	newest, err := s.CreateCockpitInput(ctx, p, CockpitInputCreateInput{CommandKey: util.UUIDToString(dbid.NewV7()), Title: "100%_material newest"})
	if err != nil {
		t.Fatal(err)
	}
	query.Cursor = *first.NextCursor
	last, err := s.ListCockpitInputs(ctx, query)
	if err != nil || last.Total != 29 || len(last.Items) != 3 || last.NextCursor != nil {
		t.Fatalf("continued page after insert: %+v %v", last, err)
	}
	seen := map[string]bool{}
	for _, items := range [][]CockpitInputHeader{first.Items, last.Items} {
		for _, item := range items {
			if seen[item.ID] || !originals[item.ID] || item.ID == newest.Receipt.InputID {
				t.Fatalf("unstable or expanded continuation: %s", item.ID)
			}
			seen[item.ID] = true
		}
	}
	if len(seen) != 28 {
		t.Fatalf("lost original inputs: %d", len(seen))
	}
	query.Scope.Query = "another"
	if _, err = s.ListCockpitInputs(ctx, query); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("filter change reused prior cursor: %v", err)
	}
}
func TestCockpitInputReadEmptyManifestDoesNotCreateFactsOrDispatch(t *testing.T) {
	f, s, p := inputWriteFixture(t)
	ctx := context.Background()
	issue := parseTestUUID(t, f.Issue(t, "Input-free task"))
	query := CockpitInputQuery{CockpitInputRead: p, IssueID: issue}
	header, err := s.GetCockpitInputManifest(ctx, query)
	if err != nil || header.Revision != 0 || header.CurrentVersion != nil || header.Counts.Total != 0 || !header.CanEdit {
		t.Fatalf("empty input manifest: %+v %v", header, err)
	}
	page, err := s.ListCockpitInputManifestVersions(ctx, query)
	if err != nil || page.Total != 0 || len(page.Items) != 0 {
		t.Fatalf("empty manifest history: %+v %v", page, err)
	}
	for _, table := range []string{"cockpit_issue_input_manifest", "cockpit_issue_input_manifest_version", "cockpit"} {
		var count int64
		if err = f.Pool.QueryRow(ctx, "SELECT count(*) FROM "+table+" WHERE workspace_id=$1", p.WorkspaceID).Scan(&count); err != nil || count != 0 {
			t.Fatalf("read created %s facts: %d %v", table, count, err)
		}
	}
	var runs int64
	if err = f.Pool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue).Scan(&runs); err != nil || runs != 0 {
		t.Fatalf("read dispatched an execution: %d %v", runs, err)
	}
}
func TestCockpitInputReadAttachmentsArePagedExistingIssueFacts(t *testing.T) {
	f, s, p := inputWriteFixture(t)
	ctx := context.Background()
	issue := parseTestUUID(t, f.Issue(t, "Source attachment task"))
	other := parseTestUUID(t, f.Issue(t, "Other attachment task"))
	for i := 0; i < 28; i++ {
		f.Insert(t, "attachment", testutil.Cols{"workspace_id": p.WorkspaceID, "issue_id": issue, "uploader_type": "member", "uploader_id": p.CredentialOwnerID, "filename": fmt.Sprintf("agenda_%02d.pdf", i), "url": "/never-read-during-metadata", "content_type": "application/pdf", "size_bytes": i})
	}
	f.Insert(t, "attachment", testutil.Cols{"workspace_id": p.WorkspaceID, "issue_id": other, "uploader_type": "member", "uploader_id": p.CredentialOwnerID, "filename": "agenda_other.pdf", "url": "/never-read-during-metadata", "content_type": "application/pdf", "size_bytes": 1})
	query := CockpitInputQuery{CockpitInputRead: p, IssueID: issue, Scope: CockpitInputScope{Query: "agenda_"}}
	first, err := s.ListCockpitInputAttachments(ctx, query)
	if err != nil || len(first.Items) != 25 || first.Total != 28 || first.NextCursor == nil || first.CanCapture {
		t.Fatalf("first attachment metadata page/private provider unavailable: %+v %v", first, err)
	}
	query.Cursor = *first.NextCursor
	last, err := s.ListCockpitInputAttachments(ctx, query)
	if err != nil || len(last.Items) != 3 || last.NextCursor != nil {
		t.Fatalf("last attachment metadata page: %+v %v", last, err)
	}
	seen := map[string]bool{}
	for _, items := range [][]CockpitInputAttachment{first.Items, last.Items} {
		for _, item := range items {
			if item.IssueID != util.UUIDToString(issue) || seen[item.ID] {
				t.Fatalf("attachment scope or continuation mismatch: %+v", item)
			}
			seen[item.ID] = true
		}
	}
	query.IssueID = other
	if _, err = s.ListCockpitInputAttachments(ctx, query); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("attachment cursor crossed Issue: %v", err)
	}
	query.Cursor = ""
	query.IssueID = dbid.NewV7()
	if _, err = s.ListCockpitInputAttachments(ctx, query); !errors.Is(err, ErrCockpitWorkflowNotFound) {
		t.Fatalf("missing Issue fabricated empty picker: %v", err)
	}
}

func TestCockpitInputExpiredProofIsUnknownAcrossVersionReferenceAndManifestViews(t *testing.T) {
	f, p, inputID, versionID := inputReferenceFixture(t)
	ctx := context.Background()
	if _, err := f.Pool.Exec(ctx, "UPDATE cockpit_input_version SET availability='available',checked_at=now()-interval '10 minutes',proof_expires_at=now()-interval '5 minutes' WHERE workspace_id=$1 AND id=$2", p.WorkspaceID, versionID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.issues.CreateCockpitInputReference(ctx, CockpitInputQuery{CockpitInputRead: p, MeetingID: f.meeting}, CockpitInputReferenceCreateInput{CommandKey: util.UUIDToString(dbid.NewV7()), InputVersionID: util.UUIDToString(versionID), Purpose: "material"}); err != nil {
		t.Fatal(err)
	}
	issueID := parseTestUUID(t, f.Issue(t, "Use a historically verified material"))
	saved, err := f.issues.SaveCockpitInputManifest(ctx, CockpitInputQuery{CockpitInputRead: p, IssueID: issueID}, CockpitInputManifestSaveInput{CommandKey: util.UUIDToString(dbid.NewV7()), Items: []CockpitInputManifestItemInput{{InputVersionID: util.UUIDToString(versionID), Purpose: "material", Required: true}}})
	if err != nil {
		t.Fatal(err)
	}
	// This owns only its exact test facts. No historical input bytes are removed.
	f.Cleanup(t, "DELETE FROM cockpit_issue_input_manifest WHERE workspace_id=$1 AND issue_id=$2", p.WorkspaceID, issueID)
	f.Cleanup(t, "DELETE FROM cockpit_issue_input_manifest_version WHERE workspace_id=$1 AND issue_id=$2", p.WorkspaceID, issueID)
	f.Cleanup(t, "DELETE FROM cockpit_issue_input_manifest_item WHERE workspace_id=$1 AND manifest_version_id=$2", p.WorkspaceID, saved.Receipt.ManifestVersionID)
	detail, err := f.issues.GetCockpitInputVersion(ctx, CockpitInputQuery{CockpitInputRead: p, InputID: inputID, VersionID: versionID})
	if err != nil || detail.Version.Availability != "unknown" || detail.Version.CheckedAt == nil || detail.Version.CaptureState != "ready" {
		t.Fatalf("proof expiry lost fixed facts or claimed current availability: %+v %v", detail, err)
	}
	references, err := f.issues.ListCockpitInputReferences(ctx, CockpitInputQuery{CockpitInputRead: p, MeetingID: f.meeting})
	if err != nil || references.Summary.AvailableReady != 0 || references.Summary.UnknownReady != 1 || references.Items[0].Version.Availability != "unknown" {
		t.Fatalf("reference counts disagree with version availability: %+v %v", references, err)
	}
	manifest, err := f.issues.GetCockpitInputManifest(ctx, CockpitInputQuery{CockpitInputRead: p, IssueID: issueID})
	if err != nil || manifest.Counts.AvailableRequired != 0 || manifest.Counts.UnknownRequired != 1 {
		t.Fatalf("manifest counts retained expired proof: %+v %v", manifest, err)
	}
	items, err := f.issues.ListCockpitInputManifestItems(ctx, CockpitInputQuery{CockpitInputRead: p, IssueID: issueID, ManifestVersionID: parseTestUUID(t, saved.Receipt.ManifestVersionID)})
	if err != nil || len(items.Items) != 1 || items.Items[0].Availability != "unknown" {
		t.Fatalf("fixed item view disagrees with manifest summary: %+v %v", items, err)
	}
	var stored string
	if err = f.Pool.QueryRow(ctx, "SELECT availability FROM cockpit_input_version WHERE workspace_id=$1 AND id=$2", p.WorkspaceID, versionID).Scan(&stored); err != nil || stored != "available" {
		t.Fatalf("a read rewrote the last stored observation: %s %v", stored, err)
	}
}
