package service

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func inputReferenceFixture(t *testing.T) (cockpitWorkflowFixture, CockpitInputRead, pgtype.UUID, pgtype.UUID) {
	t.Helper()
	f := lifecycleFixture(t)
	p := CockpitInputRead{WorkspaceID: f.ws, CredentialOwnerID: f.owner, ActorSource: "human"}
	ctx := context.Background()
	created, err := f.issues.CreateCockpitInput(ctx, p, CockpitInputCreateInput{CommandKey: util.UUIDToString(dbid.NewV7()), Title: "Meeting materials"})
	if err != nil {
		t.Fatal(err)
	}
	inputID := parseTestUUID(t, created.Receipt.InputID)
	f.Cleanup(t, "DELETE FROM cockpit_input WHERE workspace_id=$1 AND id=$2", f.ws, inputID)
	versionID, transferID := dbid.NewV7(), dbid.NewV7()
	now := time.Now().UTC()
	hash := strings.Repeat("a", 64)
	f.Insert(t, "cockpit_input_transfer", testutil.Cols{"id": transferID, "workspace_id": f.ws, "input_id": inputID, "version_id": versionID, "transfer_number": 1, "command_key": dbid.NewV7(), "request_hash": hash, "command_receipt": testutil.Raw("'{}'::jsonb"), "actor_type": "member", "actor_id": f.owner, "credential_owner_user_id": f.owner, "authorizing_user_id": f.owner, "kind": "direct_upload", "mode": "initial", "state": "verified", "owned_storage_key": "fixture-only-not-read", "expected_bytes": 4, "bytes_received": 4, "pinned_size_bytes": 4, "content_hash": hash, "content_pin_at": now, "session_expires_at": now.Add(time.Hour), "io_finished_at": now, "io_outcome": "verified", "finished_at": now, "finalize_key": dbid.NewV7(), "finalize_hash": hash, "finalize_receipt": testutil.Raw("'{}'::jsonb")})
	f.Insert(t, "cockpit_input_version", testutil.Cols{"id": versionID, "workspace_id": f.ws, "input_id": inputID, "version_number": 1, "submission_key": dbid.NewV7(), "request_hash": hash, "submission_receipt": testutil.Raw("'{}'::jsonb"), "actor_type": "member", "actor_id": f.owner, "credential_owner_user_id": f.owner, "authorizing_user_id": f.owner, "source_kind": "upload", "payload_kind": "file", "filename": "agenda.pdf", "content_type": "application/pdf", "declared_size_bytes": 4, "pinned_size_bytes": 4, "content_hash": hash, "pinned_at": now, "capture_state": "ready", "ready_at": now, "accepted_transfer_id": transferID, "current_transfer_id": transferID, "availability": "unavailable"})
	if _, err = f.q.SetCockpitInputCurrentVersion(ctx, db.SetCockpitInputCurrentVersionParams{WorkspaceID: f.ws, ID: inputID, CurrentVersionID: versionID, Revision: 1}); err != nil {
		t.Fatal(err)
	}
	f.Cleanup(t, "DELETE FROM cockpit_input_reference WHERE workspace_id=$1", f.ws)
	return f, p, inputID, versionID
}
func TestCockpitInputReferencesKeepExactAgendaAndRemovedCommandHistory(t *testing.T) {
	f, p, _, version := inputReferenceFixture(t)
	ctx := context.Background()
	agenda, _ := lifecycleAgenda(t, f, "Decision discussion", "")
	agendaID := *agenda.Receipt.AgendaID
	query := CockpitInputQuery{CockpitInputRead: p, MeetingID: f.meeting}
	in := CockpitInputReferenceCreateInput{CommandKey: util.UUIDToString(dbid.NewV7()), AgendaID: &agendaID, InputVersionID: util.UUIDToString(version), Purpose: "material"}
	first, err := f.issues.CreateCockpitInputReference(ctx, query, in)
	if err != nil || first.Current == nil || first.Current.Version.ID != util.UUIDToString(version) || first.Receipt.AgendaID == nil || *first.Receipt.AgendaID != agendaID {
		t.Fatalf("exact agenda reference: %+v %v", first, err)
	}
	duplicate := in
	duplicate.CommandKey = util.UUIDToString(dbid.NewV7())
	if _, err = f.issues.CreateCockpitInputReference(ctx, query, duplicate); inputErrorCode(err) != "reference_exists" {
		t.Fatalf("duplicate exact reference accepted: %v", err)
	}
	meeting := in
	meeting.CommandKey = util.UUIDToString(dbid.NewV7())
	meeting.AgendaID = nil
	whole, err := f.issues.CreateCockpitInputReference(ctx, query, meeting)
	if err != nil {
		t.Fatal(err)
	}
	query.ReferenceID = parseTestUUID(t, first.Receipt.ReferenceID)
	remove := CockpitInputReferenceRemoveInput{CommandKey: util.UUIDToString(dbid.NewV7())}
	removed, err := f.issues.RemoveCockpitInputReference(ctx, query, remove)
	if err != nil || !removed.Receipt.Removed || removed.Current == nil || removed.Current.RemovedAt == nil {
		t.Fatalf("remove exact agenda reference: %+v %v", removed, err)
	}
	query.CommandKey = parseTestUUID(t, remove.CommandKey)
	found, err := f.issues.GetCockpitInputReferenceCommand(ctx, query)
	if err != nil || !reflect.DeepEqual(found.Receipt, removed.Receipt) {
		t.Fatalf("removal command lost fixed receipt: %+v %v", found, err)
	}
	replay, err := f.issues.CreateCockpitInputReference(ctx, query, in)
	if err != nil || !replay.Replayed || !reflect.DeepEqual(replay.Receipt, first.Receipt) || replay.Current == nil || replay.Current.RemovedAt == nil {
		t.Fatalf("creation replay revived removed reference: %+v %v", replay, err)
	}
	page, err := f.issues.ListCockpitInputReferences(ctx, CockpitInputQuery{CockpitInputRead: p, MeetingID: f.meeting})
	if err != nil || page.Total != 1 || len(page.Items) != 1 || page.Items[0].ID != whole.Receipt.ReferenceID {
		t.Fatalf("agenda removal expanded to whole-meeting reference: %+v %v", page, err)
	}
}
func TestCockpitInputReferenceCleanupRemainsAvailableAfterMeetingArchive(t *testing.T) {
	f, p, inputID, version := inputReferenceFixture(t)
	ctx := context.Background()
	query := CockpitInputQuery{CockpitInputRead: p, MeetingID: f.meeting}
	in := CockpitInputReferenceCreateInput{CommandKey: util.UUIDToString(dbid.NewV7()), InputVersionID: util.UUIDToString(version), Purpose: "material"}
	head, err := f.issues.GetCockpitInput(ctx, CockpitInputQuery{CockpitInputRead: p, InputID: inputID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.issues.ArchiveCockpitInput(ctx, CockpitInputQuery{CockpitInputRead: p, InputID: inputID}, CockpitInputArchiveInput{ExpectedRevision: head.Revision, Archived: true}); err != nil {
		t.Fatal(err)
	}
	ref, err := f.issues.CreateCockpitInputReference(ctx, query, in)
	if err != nil {
		t.Fatalf("archived input blocked explicit historical reuse: %v", err)
	}
	if _, err = f.Pool.Exec(ctx, "UPDATE cockpit_meeting SET archived_at=now(),archived_by=$3,archived_reason='Retain completed preparation history' WHERE workspace_id=$1 AND id=$2", f.ws, f.meeting, f.owner); err != nil {
		t.Fatal(err)
	}
	another := in
	another.CommandKey = util.UUIDToString(dbid.NewV7())
	another.Purpose = "supporting"
	if _, err = f.issues.CreateCockpitInputReference(ctx, query, another); inputErrorCode(err) != "meeting_archived" {
		t.Fatalf("archived meeting accepted new preparation material: %v", err)
	}
	member := f.member(t, "reference-cleanup-member")
	query.CredentialOwnerID = parseTestUUID(t, member)
	query.ReferenceID = parseTestUUID(t, ref.Receipt.ReferenceID)
	removed, err := f.issues.RemoveCockpitInputReference(ctx, query, CockpitInputReferenceRemoveInput{CommandKey: util.UUIDToString(dbid.NewV7())})
	if err != nil || !removed.Receipt.Removed || removed.Receipt.Principal.AuthorizingUserID != member {
		t.Fatalf("current member could not clean an archived meeting reference: %+v %v", removed, err)
	}
}
func TestCockpitInputReferenceCommandsCannotReuseCreateKeyForRemoval(t *testing.T) {
	f, p, _, version := inputReferenceFixture(t)
	ctx := context.Background()
	query := CockpitInputQuery{CockpitInputRead: p, MeetingID: f.meeting}
	in := CockpitInputReferenceCreateInput{CommandKey: util.UUIDToString(dbid.NewV7()), InputVersionID: util.UUIDToString(version), Purpose: "material"}
	created, err := f.issues.CreateCockpitInputReference(ctx, query, in)
	if err != nil {
		t.Fatal(err)
	}
	query.ReferenceID = parseTestUUID(t, created.Receipt.ReferenceID)
	if _, err = f.issues.RemoveCockpitInputReference(ctx, query, CockpitInputReferenceRemoveInput{CommandKey: in.CommandKey}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("create key reused as removal: %v", err)
	}
	other := f.member(t, "different-reference-actor")
	query.CredentialOwnerID = parseTestUUID(t, other)
	query.CommandKey = parseTestUUID(t, in.CommandKey)
	if _, err = f.issues.GetCockpitInputReferenceCommand(ctx, query); !errors.Is(err, ErrCockpitWorkflowForbidden) {
		t.Fatalf("another member obtained original command receipt: %v", err)
	}
	var active int64
	if err = f.Pool.QueryRow(ctx, "SELECT count(*) FROM cockpit_input_reference WHERE workspace_id=$1 AND removed_at IS NULL", f.ws).Scan(&active); err != nil || active != 1 {
		t.Fatalf("rejected command changed the original reference: %d %v", active, err)
	}
}

func TestCockpitInputReferenceReceiptRetainsUppercaseCommandKeys(t *testing.T) {
	f, p, _, version := inputReferenceFixture(t)
	ctx := context.Background()
	query := CockpitInputQuery{CockpitInputRead: p, MeetingID: f.meeting}
	in := CockpitInputReferenceCreateInput{CommandKey: "ABCDEFAB-0000-4000-8000-000000000001", InputVersionID: util.UUIDToString(version), Purpose: "material"}
	created, err := f.issues.CreateCockpitInputReference(ctx, query, in)
	if err != nil {
		t.Fatal(err)
	}
	query.CommandKey = parseTestUUID(t, in.CommandKey)
	replay, err := f.issues.GetCockpitInputReferenceCommand(ctx, query)
	if err != nil || !reflect.DeepEqual(created.Receipt, replay.Receipt) || replay.CommandKey != in.CommandKey {
		t.Fatalf("original uppercase creation receipt changed or could not be read: %+v %v", replay, err)
	}
	query.ReferenceID = parseTestUUID(t, created.Receipt.ReferenceID)
	remove := CockpitInputReferenceRemoveInput{CommandKey: "ABCDEFAB-0000-4000-8000-000000000002"}
	removed, err := f.issues.RemoveCockpitInputReference(ctx, query, remove)
	if err != nil {
		t.Fatal(err)
	}
	query.CommandKey = parseTestUUID(t, remove.CommandKey)
	replay, err = f.issues.GetCockpitInputReferenceCommand(ctx, query)
	if err != nil || !reflect.DeepEqual(removed.Receipt, replay.Receipt) || replay.CommandKey != remove.CommandKey {
		t.Fatalf("original uppercase removal receipt changed or could not be read: %+v %v", replay, err)
	}
}
func TestCockpitInputPrincipalReceiptRejectsMalformedUUID(t *testing.T) {
	id := util.UUIDToString(dbid.NewV7())
	principal := CockpitInputPrincipal{ActorType: "member", ActorID: id, CredentialOwnerUserID: id, AuthorizingUserID: id}
	if _, err := inputParsePrincipalIDs(principal); err != nil {
		t.Fatal(err)
	}
	principal.AuthorizingUserID = "not-a-uuid"
	if _, err := inputParsePrincipalIDs(principal); inputErrorCode(err) != "input_integrity_error" {
		t.Fatalf("corrupt authorizer hidden: %v", err)
	}
	principal.AuthorizingUserID = id
	invalid := ""
	principal.RunID = &invalid
	if _, err := inputParsePrincipalIDs(principal); inputErrorCode(err) != "input_integrity_error" {
		t.Fatalf("corrupt optional identity hidden: %v", err)
	}
}
