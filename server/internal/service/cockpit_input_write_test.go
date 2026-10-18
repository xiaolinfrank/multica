package service

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func inputWriteFixture(t *testing.T) (principalFixture, *IssueService, CockpitInputRead) {
	t.Helper()
	f, owner := newPrincipalFixture(t)
	ws := parseTestUUID(t, f.WorkspaceID)
	f.Cleanup(t, "DELETE FROM cockpit_input WHERE workspace_id=$1", ws)
	svc := &IssueService{Queries: f.q, TxStarter: f.Pool, Bus: events.New()}
	return f, svc, CockpitInputRead{WorkspaceID: ws, CredentialOwnerID: parseTestUUID(t, owner), ActorSource: "human"}
}
func TestCockpitInputRegistrationHasNoHiddenIssueBoardOrExecution(t *testing.T) {
	f, s, p := inputWriteFixture(t)
	ctx := context.Background()
	in := CockpitInputCreateInput{CommandKey: util.UUIDToString(dbid.NewV7()), Title: " Original input ", Description: "  exact description\n"}
	first, err := s.CreateCockpitInput(ctx, p, in)
	if err != nil || first.Receipt.InputRevision != 1 || first.Current == nil || first.Current.CurrentVersion != nil || first.Receipt.Title != "Original input" || first.Receipt.Description != in.Description {
		t.Fatalf("registration: %+v %v", first, err)
	}
	for label, query := range map[string]string{"board": "SELECT count(*) FROM cockpit WHERE workspace_id=$1", "Issue": "SELECT count(*) FROM issue WHERE workspace_id=$1", "Run": "SELECT count(*) FROM agent_task_queue t JOIN agent a ON a.id=t.agent_id WHERE a.workspace_id=$1"} {
		var n int64
		if err = f.Pool.QueryRow(ctx, query, p.WorkspaceID).Scan(&n); err != nil || n != 0 {
			t.Fatalf("hidden %s created: %d %v", label, n, err)
		}
	}
	id := parseTestUUID(t, first.Receipt.InputID)
	edited, err := s.EditCockpitInput(ctx, CockpitInputQuery{CockpitInputRead: p, InputID: id}, CockpitInputEditInput{ExpectedRevision: 1, Title: "Later title", Description: "Different description"})
	if err != nil || edited.Revision != 2 {
		t.Fatalf("edit: %+v %v", edited, err)
	}
	replay, err := s.CreateCockpitInput(ctx, p, in)
	if err != nil || !replay.Replayed || !reflect.DeepEqual(replay.Receipt, first.Receipt) || replay.Current == nil || replay.Current.Revision != 2 {
		t.Fatalf("original receipt changed or current guessed: %+v %v", replay, err)
	}
	queried, err := s.GetCockpitInputCreateCommand(ctx, CockpitInputQuery{CockpitInputRead: p, CommandKey: parseTestUUID(t, in.CommandKey)})
	if err != nil || !reflect.DeepEqual(queried.Receipt, first.Receipt) {
		t.Fatalf("key lookup: %+v %v", queried, err)
	}
	changed := in
	changed.Description = "not the same intent"
	if _, err = s.CreateCockpitInput(ctx, p, changed); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("same key changed intent: %v", err)
	}
}
func TestCockpitInputConcurrentRegistrationKeepsOneExactReceipt(t *testing.T) {
	f, s, p := inputWriteFixture(t)
	ctx := context.Background()
	in := CockpitInputCreateInput{CommandKey: util.UUIDToString(dbid.NewV7()), Title: "One input"}
	var group sync.WaitGroup
	results := make(chan CockpitInputCreateResult, 2)
	failures := make(chan error, 2)
	for range 2 {
		group.Add(1)
		go func() { defer group.Done(); r, err := s.CreateCockpitInput(ctx, p, in); results <- r; failures <- err }()
	}
	group.Wait()
	close(results)
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	var id string
	replayed := 0
	for r := range results {
		if id != "" && id != r.Receipt.InputID {
			t.Fatal("one command created distinct inputs")
		}
		id = r.Receipt.InputID
		if r.Replayed {
			replayed++
		}
	}
	var n int64
	if err := f.Pool.QueryRow(ctx, "SELECT count(*) FROM cockpit_input WHERE workspace_id=$1", p.WorkspaceID).Scan(&n); err != nil || n != 1 || replayed != 1 {
		t.Fatalf("count=%d replays=%d error=%v", n, replayed, err)
	}
}
func TestCockpitInputRegistrationRetainsTaskOriginatorAndReplaysBeforeRevokedInvoke(t *testing.T) {
	f, s, human := inputWriteFixture(t)
	ctx := context.Background()
	owner := f.member(t, "input-runtime-owner")
	runtime := f.Runtime(t, "Input runtime", testutil.Cols{"owner_id": owner, "visibility": "public"})
	agent := f.Agent(t, "Input agent", runtime, testutil.Cols{"owner_id": human.CredentialOwnerID, "permission_mode": "private", "status": "idle"})
	issue := f.Issue(t, "Source Issue")
	run := f.Task(t, agent, testutil.Cols{"issue_id": issue, "runtime_id": runtime, "status": "running", "originator_user_id": human.CredentialOwnerID, "accountable_user_id": human.CredentialOwnerID})
	token, err := f.q.CreateTaskToken(ctx, db.CreateTaskTokenParams{ID: dbid.NewV7(), TokenHash: util.UUIDToString(dbid.NewV7()), TaskID: parseTestUUID(t, run), AgentID: parseTestUUID(t, agent), WorkspaceID: human.WorkspaceID, UserID: parseTestUUID(t, owner), ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	if err != nil {
		t.Fatal(err)
	}
	f.Cleanup(t, "DELETE FROM task_token WHERE id=$1", token.ID)
	p := CockpitInputRead{WorkspaceID: human.WorkspaceID, CredentialOwnerID: parseTestUUID(t, owner), ActorSource: "task_token", AgentID: parseTestUUID(t, agent), RunID: parseTestUUID(t, run), TaskTokenID: token.ID}
	in := CockpitInputCreateInput{CommandKey: util.UUIDToString(dbid.NewV7()), Title: "Collected source"}
	first, err := s.CreateCockpitInput(ctx, p, in)
	if err != nil || first.Receipt.Principal.ActorType != "agent" || first.Receipt.Principal.AuthorizingUserID != util.UUIDToString(human.CredentialOwnerID) || first.Receipt.Principal.CredentialOwnerUserID != owner {
		t.Fatalf("actor tuple: %+v %v", first, err)
	}
	if _, err = f.Pool.Exec(ctx, "UPDATE agent SET owner_id=$1 WHERE id=$2", owner, agent); err != nil {
		t.Fatal(err)
	}
	replay, err := s.CreateCockpitInput(ctx, p, in)
	if err != nil || !replay.Replayed || !reflect.DeepEqual(replay.Receipt, first.Receipt) || replay.Current != nil {
		t.Fatalf("revocation lost original receipt or leaked current: %+v %v", replay, err)
	}
	in.CommandKey = util.UUIDToString(dbid.NewV7())
	if _, err = s.CreateCockpitInput(ctx, p, in); !errors.Is(err, ErrCockpitWorkflowForbidden) {
		t.Fatalf("new command borrowed credential-owner authority: %v", err)
	}
	var n int64
	if err = f.Pool.QueryRow(ctx, "SELECT count(*) FROM cockpit_input WHERE workspace_id=$1", p.WorkspaceID).Scan(&n); err != nil || n != 1 {
		t.Fatalf("new revoked input count=%d %v", n, err)
	}
}

func TestCockpitInputSharedIOBudgetKeepsReservationsUntilActualClose(t *testing.T) {
	b := &cockpitInputIOBudget{}
	one, err := b.reserve(context.Background(), CockpitInputMaxFileBytes)
	if err != nil {
		t.Fatal(err)
	}
	two, err := b.reserve(context.Background(), CockpitInputMaxFileBytes)
	if err != nil {
		t.Fatal(err)
	}
	defer one()
	defer two()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = b.reserve(ctx, 1); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled reservation: %v", err)
	}
	if _, err = b.reserve(context.Background(), 1); inputErrorCode(err) != "input_io_busy" {
		t.Fatalf("capacity escaped Go service budget: %v", err)
	}
	one()
	one()
	replacement, err := b.reserve(context.Background(), CockpitInputMaxFileBytes)
	if err != nil {
		t.Fatal(err)
	}
	defer replacement()
	if _, err = b.reserve(context.Background(), 0); inputErrorCode(err) != "input_io_busy" {
		t.Fatal("duplicate close freed another reader's slot")
	}
}

func TestCockpitInputCreateCommandKeepsExactAcceptedKeySpelling(t *testing.T) {
	_, s, p := inputWriteFixture(t)
	ctx := context.Background()
	in := CockpitInputCreateInput{CommandKey: strings.ToUpper(util.UUIDToString(dbid.NewV7())), Title: "External CLI registration"}
	first, err := s.CreateCockpitInput(ctx, p, in)
	if err != nil {
		t.Fatal(err)
	}
	found, err := s.GetCockpitInputCreateCommand(ctx, CockpitInputQuery{CockpitInputRead: p, CommandKey: inputTrustedID(in.CommandKey)})
	if err != nil || found.CommandKey != first.CommandKey || !reflect.DeepEqual(found.Receipt, first.Receipt) {
		t.Fatalf("reading the accepted UUID changed the fixed envelope: %+v %v", found, err)
	}
}
