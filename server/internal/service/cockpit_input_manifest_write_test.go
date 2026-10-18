package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

type inputManifestFailReadTx struct {
	pgx.Tx
	err error
}
type inputManifestFailureRow struct{ err error }

func (r inputManifestFailureRow) Scan(...any) error { return r.err }
func (t inputManifestFailReadTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if strings.Contains(sql, "-- name: GetCockpitInputManifest :one") {
		return inputManifestFailureRow{t.err}
	}
	return t.Tx.QueryRow(ctx, sql, args...)
}

type inputManifestFailReadStarter struct {
	TxStarter
	err error
}

func (s inputManifestFailReadStarter) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return inputManifestFailReadTx{Tx: tx, err: s.err}, nil
}

func TestCockpitInputManifestCurrentReadFailureIsNotAnEmptyProjection(t *testing.T) {
	f, s, q := inputManifestFixture(t)
	ctx := context.Background()
	command := CockpitInputManifestSaveInput{CommandKey: util.UUIDToString(dbid.NewV7()), Items: []CockpitInputManifestItemInput{}}
	saved, err := s.SaveCockpitInputManifest(ctx, q, command)
	if err != nil {
		t.Fatal(err)
	}
	q.CommandKey = inputTrustedID(command.CommandKey)
	databaseFailure := errors.New("injected current metadata database failure")
	broken := &IssueService{Queries: s.Queries, TxStarter: inputManifestFailReadStarter{TxStarter: f.Pool, err: databaseFailure}}
	if _, err = broken.GetCockpitInputManifestCommand(ctx, q); !errors.Is(err, databaseFailure) {
		t.Fatalf("database failure became an apparently valid nullable projection: %v", err)
	}
	broken.TxStarter = inputManifestFailReadStarter{TxStarter: f.Pool, err: inputError("permission_revoked", "permission changed after receipt lookup")}
	recovered, err := broken.GetCockpitInputManifestCommand(ctx, q)
	if err != nil || recovered.Current != nil || !reflect.DeepEqual(recovered.Receipt, saved.Receipt) {
		t.Fatalf("permission revocation discarded original accepted receipt: %+v %v", recovered, err)
	}
}

func inputManifestFixture(t *testing.T) (principalFixture, *IssueService, CockpitInputQuery) {
	t.Helper()
	f, s, p, _ := inputUploadFixture(t)
	issue := parseTestUUID(t, f.Issue(t, "Issue with explicitly selected inputs"))
	f.Cleanup(t, "DELETE FROM cockpit_issue_input_manifest_version WHERE workspace_id=$1", p.WorkspaceID)
	f.Cleanup(t, "DELETE FROM cockpit_issue_input_manifest_item WHERE workspace_id=$1", p.WorkspaceID)
	f.Cleanup(t, "DELETE FROM cockpit_issue_input_manifest WHERE workspace_id=$1", p.WorkspaceID)
	return f, s, CockpitInputQuery{CockpitInputRead: p, IssueID: issue}
}

func inputManifestReadyFile(t *testing.T, s *IssueService, p CockpitInputRead, body string) CockpitInputQuery {
	t.Helper()
	q, initial := inputSubmitUpload(t, s, p, body)
	upload, err := s.UploadCockpitInputBytes(context.Background(), q, *initial.Receipt.TransferRevision, bytes.NewBufferString(body))
	if err != nil || upload.Current == nil {
		t.Fatalf("prepare real fixed input: %+v %v", upload, err)
	}
	digest := sha256.Sum256([]byte(body))
	_, err = s.FinalizeCockpitInputTransfer(context.Background(), q, CockpitInputFinalizeInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: upload.Current.Revision, ExpectedContentHash: hex.EncodeToString(digest[:])})
	if err != nil {
		t.Fatal(err)
	}
	return q
}

func TestCockpitInputManifestKeepsExactReceiptAndOrderedFixedVersions(t *testing.T) {
	f, s, q := inputManifestFixture(t)
	ctx := context.Background()
	first := inputManifestReadyFile(t, s, q.CockpitInputRead, " first exact bytes ")
	second := inputManifestReadyFile(t, s, q.CockpitInputRead, "second\n")
	if _, err := s.ArchiveCockpitInput(ctx, CockpitInputQuery{CockpitInputRead: q.CockpitInputRead, InputID: first.InputID}, CockpitInputArchiveInput{ExpectedRevision: 2, Archived: true}); err != nil {
		t.Fatal(err)
	}
	in := CockpitInputManifestSaveInput{CommandKey: strings.ToUpper(util.UUIDToString(dbid.NewV7())), ExpectedRevision: 0, Note: "  exact note\n", Items: []CockpitInputManifestItemInput{{InputVersionID: util.UUIDToString(second.VersionID), Purpose: "material", Required: true}, {InputVersionID: util.UUIDToString(first.VersionID), Purpose: "supporting", Required: false}}}
	saved, err := s.SaveCockpitInputManifest(ctx, q, in)
	if err != nil || saved.CommandKey != in.CommandKey || saved.Receipt.CommandKey != in.CommandKey || saved.Current == nil || saved.Current.Revision != 1 || saved.Receipt.Note != in.Note || saved.Receipt.Items[0].InputVersionID != in.Items[0].InputVersionID {
		t.Fatalf("save complete order: %+v %v", saved, err)
	}
	q.ManifestVersionID = inputTrustedID(saved.Receipt.ManifestVersionID)
	q.PageSize = 1
	page, err := s.ListCockpitInputManifestItems(ctx, q)
	if err != nil || len(page.Items) != 1 || page.Items[0].InputVersionID != in.Items[0].InputVersionID || page.NextCursor == nil {
		t.Fatalf("fixed first page: %+v %v", page, err)
	}
	q.Cursor = *page.NextCursor
	page, err = s.ListCockpitInputManifestItems(ctx, q)
	if err != nil || len(page.Items) != 1 || page.Items[0].InputVersionID != in.Items[1].InputVersionID || page.NextCursor != nil {
		t.Fatalf("fixed second page: %+v %v", page, err)
	}
	next := CockpitInputManifestSaveInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: 1, Items: []CockpitInputManifestItemInput{}, Note: "explicitly no inputs"}
	changed, err := s.SaveCockpitInputManifest(ctx, q, next)
	if err != nil || changed.Receipt.Revision != 2 || changed.Receipt.ManifestHash == saved.Receipt.ManifestHash {
		t.Fatalf("explicit empty version: %+v %v", changed, err)
	}
	replayed, err := s.SaveCockpitInputManifest(ctx, q, in)
	if err != nil || !replayed.Replayed || !reflect.DeepEqual(replayed.Receipt, saved.Receipt) || replayed.Current == nil || replayed.Current.Revision != 2 {
		t.Fatalf("receipt replaced by new current: %+v %v", replayed, err)
	}
	q.CommandKey = inputTrustedID(in.CommandKey)
	recovered, err := s.GetCockpitInputManifestCommand(ctx, q)
	if err != nil || !reflect.DeepEqual(recovered.Receipt, saved.Receipt) {
		t.Fatalf("GET exact receipt: %+v %v", recovered, err)
	}
	wrong := in
	wrong.Note = "different intent"
	if _, err = s.SaveCockpitInputManifest(ctx, q, wrong); inputErrorCode(err) != "command_conflict" {
		t.Fatalf("same-key changed body: %v", err)
	}
	other := q
	other.CredentialOwnerID = parseTestUUID(t, f.member(t, "other-member"))
	if _, err = s.GetCockpitInputManifestCommand(ctx, other); inputErrorCode(err) != "permission_revoked" {
		t.Fatalf("foreign principal read command: %v", err)
	}
	var tasks int
	if err = f.Pool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", q.IssueID).Scan(&tasks); err != nil || tasks != 0 {
		t.Fatalf("saving launched a task: %d %v", tasks, err)
	}
}

func TestCockpitInputManifestConcurrentConfirmationCommitsOneVersion(t *testing.T) {
	_, s, q := inputManifestFixture(t)
	ctx := context.Background()
	in := CockpitInputManifestSaveInput{CommandKey: util.UUIDToString(dbid.NewV7()), Items: []CockpitInputManifestItemInput{}}
	results := make(chan CockpitInputManifestResult, 2)
	failures := make(chan error, 2)
	var group sync.WaitGroup
	for range 2 {
		group.Add(1)
		go func() {
			defer group.Done()
			out, err := s.SaveCockpitInputManifest(ctx, q, in)
			results <- out
			failures <- err
		}()
	}
	group.Wait()
	close(results)
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	id := ""
	replays := 0
	for out := range results {
		if id != "" && id != out.Receipt.ManifestVersionID {
			t.Fatal("one intent created multiple manifests")
		}
		id = out.Receipt.ManifestVersionID
		if out.Replayed {
			replays++
		}
	}
	if replays != 1 {
		t.Fatalf("replays=%d", replays)
	}
	bad := in
	bad.CommandKey = util.UUIDToString(dbid.NewV7())
	bad.Items = []CockpitInputManifestItemInput{{InputVersionID: util.UUIDToString(dbid.NewV7()), Purpose: "material", Required: true}}
	bad.ExpectedRevision = 1
	if _, err := s.SaveCockpitInputManifest(ctx, q, bad); inputErrorCode(err) != "not_found" {
		t.Fatalf("foreign/missing version accepted: %v", err)
	}
	current, err := s.GetCockpitInputManifest(ctx, q)
	if err != nil || current.Revision != 1 {
		t.Fatalf("failed selection changed manifest: %+v %v", current, err)
	}
}

func inputManifestTaskAgent(t *testing.T, f principalFixture, p CockpitInputRead, issue pgtype.UUID) (pgtype.UUID, pgtype.UUID) {
	t.Helper()
	runtime := parseTestUUID(t, f.Runtime(t, "Fixed input runtime", testutil.Cols{"owner_id": p.CredentialOwnerID, "status": "online", "metadata": testutil.Raw(`'{"capabilities":["fixed_input_manifest_v1"]}'::jsonb`)}))
	agent := parseTestUUID(t, f.Agent(t, "Fixed input agent", util.UUIDToString(runtime), testutil.Cols{"owner_id": p.CredentialOwnerID, "status": "idle", "permission_mode": "private"}))
	if _, err := f.Pool.Exec(context.Background(), "UPDATE issue SET assignee_id=$2,assignee_type='agent' WHERE id=$1", issue, agent); err != nil {
		t.Fatal(err)
	}
	f.Cleanup(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", issue)
	return runtime, agent
}

func inputManifestSaveEmpty(t *testing.T, s *IssueService, q CockpitInputQuery, revision int64) pgtype.UUID {
	t.Helper()
	r, err := s.SaveCockpitInputManifest(context.Background(), q, CockpitInputManifestSaveInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: revision, Items: []CockpitInputManifestItemInput{}})
	if err != nil {
		t.Fatal(err)
	}
	return inputTrustedID(r.Receipt.ManifestVersionID)
}

func TestCockpitInputManifestCanonicalEnqueueRetryAndRerunKeepPins(t *testing.T) {
	f, s, q := inputManifestFixture(t)
	ctx := context.Background()
	runtime, agent := inputManifestTaskAgent(t, f, q.CockpitInputRead, q.IssueID)
	tasks := NewTaskService(f.q, f.Pool, nil, s.Bus)
	issue, err := f.q.GetIssue(ctx, q.IssueID)
	if err != nil {
		t.Fatal(err)
	}
	legacy, err := tasks.EnqueueTaskForIssueByActor(ctx, issue, q.CredentialOwnerID)
	if err != nil {
		t.Fatal(err)
	}
	if legacy.InputManifestVersionID.Valid || legacy.InputPreparationState != "not_recorded" {
		t.Fatal("legacy Run acquired invented inputs")
	}
	if _, err = f.Pool.Exec(ctx, "UPDATE agent_task_queue SET status='failed' WHERE id=$1", legacy.ID); err != nil {
		t.Fatal(err)
	}
	first := inputManifestSaveEmpty(t, s, q, 0)
	oldRetry, err := f.q.CreateRetryTask(ctx, db.CreateRetryTaskParams{ID: legacy.ID})
	if err != nil || oldRetry.InputManifestVersionID.Valid {
		t.Fatalf("old automatic retry substituted current pin: %+v %v", oldRetry, err)
	}
	if _, err = f.Pool.Exec(ctx, "UPDATE agent_task_queue SET status='cancelled' WHERE id=$1", oldRetry.ID); err != nil {
		t.Fatal(err)
	}
	current, err := tasks.EnqueueTaskForIssueByActor(ctx, issue, q.CredentialOwnerID)
	if err != nil || current.InputManifestVersionID != first || current.InputPreparationState != "pending" {
		t.Fatalf("canonical enqueue did not fix current manifest: %+v %v", current, err)
	}
	second := inputManifestSaveEmpty(t, s, q, 1)
	if _, err = tasks.RerunIssue(ctx, q.IssueID, pgtype.UUID{}, pgtype.UUID{}, q.CredentialOwnerID, nil, first); inputErrorCode(err) != "input_manifest_changed" {
		t.Fatalf("stale explicit authorization accepted: %v", err)
	}
	unchanged, err := f.q.GetAgentTask(ctx, current.ID)
	if err != nil || unchanged.Status != "queued" {
		t.Fatalf("precondition rejection cancelled prior task: %+v %v", unchanged, err)
	}
	newRun, err := tasks.RerunIssue(ctx, q.IssueID, pgtype.UUID{}, pgtype.UUID{}, q.CredentialOwnerID, nil, second)
	if err != nil || newRun.InputManifestVersionID != second {
		t.Fatalf("new explicitly authorized Run: %+v %v", newRun, err)
	}
	inherited, err := tasks.RerunIssue(ctx, q.IssueID, legacy.ID, pgtype.UUID{}, q.CredentialOwnerID, nil)
	if err != nil || inherited.InputManifestVersionID.Valid {
		t.Fatalf("named historical Run lost its NULL pin: %+v %v", inherited, err)
	}
	if _, err = f.Pool.Exec(ctx, "UPDATE agent_task_queue SET status='cancelled' WHERE id=$1", inherited.ID); err != nil {
		t.Fatal(err)
	}
	deferred, err := f.q.CreateDeferredChannelIssueTask(ctx, db.CreateDeferredChannelIssueTaskParams{AgentID: agent, RuntimeID: runtime, IssueID: q.IssueID, OriginatorUserID: q.CredentialOwnerID, AccountableUserID: q.CredentialOwnerID})
	if err != nil || deferred.InputManifestVersionID != second {
		t.Fatalf("deferred canonical task lost current pin: %+v %v", deferred, err)
	}
	if _, err = f.Pool.Exec(ctx, "UPDATE agent_task_queue SET status='cancelled' WHERE id=$1", deferred.ID); err != nil {
		t.Fatal(err)
	}
	wakeup, err := f.q.CreateWakeupTask(ctx, db.CreateWakeupTaskParams{AgentID: agent, RuntimeID: runtime, IssueID: q.IssueID, OriginatorUserID: q.CredentialOwnerID, AccountableUserID: q.CredentialOwnerID, WakeupContext: []byte(`{}`)})
	if err != nil || wakeup.InputManifestVersionID != second || wakeup.InputPreparationState != "pending" {
		t.Fatalf("wakeup canonical enqueue lost fixed input selection: %+v %v", wakeup, err)
	}
}
