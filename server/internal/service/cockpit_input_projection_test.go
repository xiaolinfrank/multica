package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/storage"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestCockpitInputProjectionKeepsRecoverySeparateFromAvailability(t *testing.T) {
	owner, agent, issue, run := dbid.NewV7(), dbid.NewV7(), dbid.NewV7(), dbid.NewV7()
	p := CockpitInputRead{ActorSource: "human", CredentialOwnerID: owner}
	a := cockpitInputAuthority{Member: db.Member{Role: "member"}, Principal: CockpitInputPrincipal{ActorType: "member"}}
	head := db.ReadCockpitInputHeadersRow{AuthorizingUserID: owner, ArchivedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true}}
	version := db.ReadCockpitInputVersionsRow{ActorType: "member", SourceKind: "upload", PayloadKind: "file", CaptureState: "needs_attention", Availability: "unknown"}
	project := func() CockpitInputVersionMetadata {
		dto := CockpitInputVersionMetadata{Source: CockpitInputSourceMetadata{SourceAvailable: version.SourceKind != "upload"}, AllowedRestartModes: []string{}, BlockedReasons: []string{}}
		inputProjectionVersionActions(&dto, p, a, head, version, true, true)
		return dto
	}
	if dto := project(); !reflect.DeepEqual(dto.AllowedRestartModes, []string{"retry_source"}) || dto.CanDownload {
		t.Fatalf("unpinned original upload recovery: %+v", dto)
	}
	version.PinnedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
	version.PinnedSizeBytes = pgtype.Int8{Int64: 4, Valid: true}
	version.ContentHash = pgtype.Text{String: strings.Repeat("a", 64), Valid: true}
	if dto := project(); !reflect.DeepEqual(dto.AllowedRestartModes, []string{"upload_matching_bytes"}) {
		t.Fatalf("pin must change human recovery to explicit matching bytes: %+v", dto)
	}
	version.CaptureState = "ready"
	version.CurrentTransferID = dbid.NewV7()
	version.Availability = "unavailable"
	if dto := project(); dto.CanDownload || !dto.CanVerify || !dto.CanReference || !dto.CanRestart {
		t.Fatalf("archived ready content lost recovery/reference or claimed unavailable download: %+v", dto)
	}
	version.Availability = "unknown"
	if dto := project(); !dto.CanDownload {
		t.Fatal("unknown observation was confused with a failed actual byte read")
	}
	version.VerificationDueAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
	if dto := project(); dto.CanVerify {
		t.Fatal("an already queued verification offered another verification action")
	}
	version.VerificationDueAt = pgtype.Timestamptz{}
	version.SourceKind = "artifact_version"
	version.CurrentTransferID = pgtype.UUID{}
	dto := CockpitInputVersionMetadata{Source: CockpitInputSourceMetadata{SourceAvailable: true}}
	inputProjectionVersionActions(&dto, p, a, head, version, true, false)
	if !reflect.DeepEqual(dto.AllowedRestartModes, []string{"upload_matching_bytes"}) || dto.CanDownload {
		t.Fatalf("private input provider granted access to an unavailable original artifact provider: %+v", dto)
	}
	version.SourceKind = "upload"
	version.CurrentTransferID = dbid.NewV7()
	p.ActorSource = "task_token"
	p.AgentID = agent
	p.RunID = run
	a.Principal.ActorType = "agent"
	a.Run = db.AgentTaskQueue{ID: run, AgentID: agent, IssueID: issue, OriginatorUserID: owner, Status: "running"}
	version.ActorType = "agent"
	version.SourceAgentID = agent
	version.SourceIssueID = issue
	version.AuthorizingUserID = owner
	if dto := project(); !reflect.DeepEqual(dto.AllowedRestartModes, []string{"retry_source"}) || dto.CanReference {
		t.Fatalf("machine gained matching/general reference rights: %+v", dto)
	}
	version.SourceKind = "nas_file"
	if dto := project(); dto.CanRestart {
		t.Fatal("same input header granted machine a new NAS read")
	}
	version.SourceKind = "upload"
	version.ActorType = "member"
	version.SourceAgentID = pgtype.UUID{}
	if dto := project(); dto.CanRestart {
		t.Fatal("a later human version became a machine source grant")
	}
	version.Availability = "future_state"
	if dto := project(); dto.CanDownload || dto.CanRestart || dto.CanVerify || dto.CanReference {
		t.Fatal("unknown state retained actions")
	}
}
func TestCockpitInputProjectionDoesNotLetManagerUploadIntoAnotherSession(t *testing.T) {
	uploader, manager := dbid.NewV7(), dbid.NewV7()
	id, versionID := dbid.NewV7(), dbid.NewV7()
	now := time.Now()
	head := db.ReadCockpitInputHeadersRow{AuthorizingUserID: uploader}
	p := CockpitInputRead{ActorSource: "human", CredentialOwnerID: manager}
	a := cockpitInputAuthority{Member: db.Member{Role: "admin"}}
	idText := util.UUIDToString(id)
	version := CockpitInputVersionMetadata{ID: util.UUIDToString(versionID), ActiveTransferID: &idText, LatestTransferID: &idText, SubmittedBy: CockpitInputPrincipal{ActorType: "member", AuthorizingUserID: util.UUIDToString(uploader)}}
	row := db.ReadCockpitInputTransfersRow{ID: id, VersionID: versionID, ActorType: pgtype.Text{String: "member", Valid: true}, ActorID: uploader, CredentialOwnerUserID: uploader, AuthorizingUserID: uploader, Kind: "direct_upload", Mode: "initial", State: "awaiting_bytes", SessionExpiresAt: pgtype.Timestamptz{Time: now.Add(time.Hour), Valid: true}}
	project := func() CockpitInputTransferMetadata {
		dto := CockpitInputTransferMetadata{ID: idText, BlockedReasons: []string{}}
		inputProjectionTransferActions(&dto, p, a, head, row, version, true, now)
		return dto
	}
	if dto := project(); dto.CanUpload || !dto.CanAbandon {
		t.Fatalf("manager silently became uploader: %+v", dto)
	}
	p.CredentialOwnerID = uploader
	a.Member.Role = "member"
	if dto := project(); !dto.CanUpload {
		t.Fatal("original uploader lost its unexpired exact session")
	}
	row.State = "awaiting_finalize"
	row.SessionExpiresAt.Time = now.Add(-time.Hour)
	row.ContentPinAt = pgtype.Timestamptz{Time: now, Valid: true}
	row.PinnedSizeBytes = pgtype.Int8{Int64: 0, Valid: true}
	row.ContentHash = pgtype.Text{String: strings.Repeat("a", 64), Valid: true}
	row.IoFinishedAt = pgtype.Timestamptz{Time: now, Valid: true}
	row.IoOutcome = pgtype.Text{String: "verified", Valid: true}
	p.CredentialOwnerID = manager
	a.Member.Role = "admin"
	if dto := project(); !dto.CanFinalize || dto.CanUpload {
		t.Fatalf("expired upload TTL prevented confirmation of already verified bytes: %+v", dto)
	}
	row.IoOutcome = pgtype.Text{}
	if dto := project(); dto.CanFinalize {
		t.Fatal("a content hash without verified I/O was treated as ready to finalize")
	}
	row.State = "future_state"
	if dto := project(); dto.CanUpload || dto.CanFinalize || dto.CanAbandon || dto.CanRestart {
		t.Fatal("unknown transfer state retained a mutation")
	}
}

type inputProjectionSpy struct {
	db.DBTX
	calls    map[string]int
	bodyRead bool
}

func (s *inputProjectionSpy) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	first := strings.SplitN(sql, "\n", 2)[0]
	s.calls[first]++
	for _, forbidden := range []string{"creation_receipt", "submission_receipt", "command_receipt", "error_message", "capture_error,"} {
		if strings.Contains(sql, forbidden) {
			s.bodyRead = true
		}
	}
	return s.DBTX.Query(ctx, sql, args...)
}

type inputProjectionNoIOStore struct {
	storage.Storage
	calls int
}

func (s *inputProjectionNoIOStore) SupportsPrivateInputFiles() bool { return true }
func (s *inputProjectionNoIOStore) GetReader(context.Context, string) (io.ReadCloser, error) {
	s.calls++
	return nil, fmt.Errorf("metadata attempted storage read")
}
func (s *inputProjectionNoIOStore) UploadStream(context.Context, string, io.Reader, int64, string, string) (string, error) {
	s.calls++
	return "", fmt.Errorf("metadata attempted storage write")
}

func TestCockpitInputProjectionBatchesIdentitiesAndExcludesReceiptBodies(t *testing.T) {
	f, s, p := inputWriteFixture(t)
	ctx := context.Background()
	store := &inputProjectionNoIOStore{}
	s.ConfigureCockpitInputStorage(store)
	registered, err := s.CreateCockpitInput(ctx, p, CockpitInputCreateInput{CommandKey: util.UUIDToString(dbid.NewV7()), Title: "Selected input", Description: "  exact description  "})
	if err != nil {
		t.Fatal(err)
	}
	inputID := parseTestUUID(t, registered.Receipt.InputID)
	rootID := dbid.NewV7()
	rootPath := filepath.Join(t.TempDir(), "disconnected")
	rootConfig, _ := json.Marshal([]cockpitnas.Root{{WorkspaceID: f.WorkspaceID, RootID: util.UUIDToString(rootID), Path: rootPath, AllowLocal: true, InputSubpaths: []string{"inputs"}}})
	nas, err := cockpitnas.New(string(rootConfig))
	if err != nil {
		t.Fatal(err)
	}
	s.ConfigureCockpitInputNAS(nas, "")
	info, err := nas.InputRoot(f.WorkspaceID)
	if err != nil {
		t.Fatal(err)
	}
	located := []db.CockpitInputVersion{}
	hash := strings.Repeat("a", 64)
	for i := 0; i < 33; i++ {
		cols := testutil.Cols{"id": dbid.NewV7(), "workspace_id": p.WorkspaceID, "input_id": inputID, "version_number": i + 1, "submission_key": dbid.NewV7(), "request_hash": hash, "submission_receipt": testutil.Raw(`'{"body":"` + strings.Repeat("do-not-project-", 1500) + `"}'::jsonb`), "actor_type": "member", "actor_id": p.CredentialOwnerID, "credential_owner_user_id": p.CredentialOwnerID, "authorizing_user_id": p.CredentialOwnerID, "source_kind": "upload", "payload_kind": "file", "filename": fmt.Sprintf("input-%d.txt", i), "content_type": "text/plain", "declared_size_bytes": 4, "capture_state": "needs_attention", "capture_error": "a long diagnostic that is never a list field"}
		if i == 0 {
			cols["source_kind"] = "nas_file"
			cols["source_root_id"] = rootID
			cols["source_root_path"] = rootPath
			cols["source_relative_path"] = "inputs/original.txt"
			cols["source_root_config_hash"] = info.RootConfigHash
			cols["source_root_identity"] = "retained-root-identity"
			cols["source_file_identity"] = hash
			cols["source_size"] = 4
			cols["source_mtime_ns"] = int64(1)
		}
		id := f.Insert(t, "cockpit_input_version", cols)
		located = append(located, db.CockpitInputVersion{ID: parseTestUUID(t, id), WorkspaceID: p.WorkspaceID, InputID: inputID})
	}
	firstVersion := located[0].ID
	var latest pgtype.UUID
	for n := 1; n <= 2; n++ {
		id := dbid.NewV7()
		f.Insert(t, "cockpit_input_transfer", testutil.Cols{"id": id, "workspace_id": p.WorkspaceID, "input_id": inputID, "version_id": firstVersion, "transfer_number": n, "command_key": dbid.NewV7(), "request_hash": hash, "command_receipt": testutil.Raw(`'{"body":"` + strings.Repeat("private-attempt-", 1000) + `"}'::jsonb`), "actor_type": "member", "actor_id": p.CredentialOwnerID, "credential_owner_user_id": p.CredentialOwnerID, "authorizing_user_id": p.CredentialOwnerID, "kind": "source_capture", "mode": "retry_source", "state": "failed", "owned_storage_key": "workspaces/" + f.WorkspaceID + "/input-versions/" + util.UUIDToString(firstVersion) + "/" + util.UUIDToString(id), "expected_bytes": 4, "error_code": "source_unavailable", "error_message": strings.Repeat("long error ", 100), "finished_at": time.Now()})
		latest = id
	}
	spy := &inputProjectionSpy{DBTX: f.Pool, calls: map[string]int{}}
	query := db.New(spy)
	single, err := s.inputVersions(ctx, query, p, located[:1])
	if err != nil {
		t.Fatal(err)
	}
	oneCalls := lenCalls(spy.calls)
	spy.calls = map[string]int{}
	// Explicit caller order must survive SQL's unspecified batch return order.
	for left, right := 0, len(located)-1; left < right; left, right = left+1, right-1 {
		located[left], located[right] = located[right], located[left]
	}
	items, err := s.inputVersions(ctx, query, p, located)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 33 || lenCalls(spy.calls) != oneCalls {
		t.Fatalf("metadata became an N+1 query path: one=%d batch=%d count=%d", oneCalls, lenCalls(spy.calls), len(items))
	}
	for i, item := range items {
		if item.ID != util.UUIDToString(located[i].ID) || item.Filename == "" || item.SubmittedBy.ActorName == "" {
			t.Fatalf("identity-only projection lost order/metadata: %+v", item)
		}
	}
	if single[0].LatestTransferID == nil || *single[0].LatestTransferID != util.UUIDToString(latest) || single[0].ActiveTransferID != nil {
		t.Fatal("failed latest transfer was replaced by an invented active transfer")
	}
	if !single[0].Source.SourceAvailable || store.calls != 0 || spy.bodyRead {
		t.Fatalf("metadata probed storage or loaded bodies: source=%+v io=%d body=%v", single[0].Source, store.calls, spy.bodyRead)
	}
	transfer, err := s.inputTransfers(ctx, query, p, []db.CockpitInputTransfer{{ID: latest, WorkspaceID: p.WorkspaceID, InputID: inputID, VersionID: firstVersion}})
	if err != nil || len(transfer) != 1 || transfer[0].State != "failed" || spy.bodyRead {
		t.Fatalf("transfer metadata read body or lost terminal state: %+v %v", transfer, err)
	}
	if _, err = s.inputVersions(ctx, query, p, []db.CockpitInputVersion{{ID: dbid.NewV7(), WorkspaceID: p.WorkspaceID}}); err == nil {
		t.Fatal("missing identity silently disappeared")
	}
}
func lenCalls(calls map[string]int) int {
	total := 0
	for _, n := range calls {
		total += n
	}
	return total
}
