package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestCockpitAssigneeChoicesUseInvocationPolicyAndBoundedMetadata(t *testing.T) {
	f, owner := newPrincipalFixture(t)
	peer := f.member(t, "assignee-peer")
	svc := NewIssueService(f.q, f.Pool, f.svc.Bus, nil, f.svc.TaskSvc)
	ws := parseTestUUID(t, f.WorkspaceID)
	runtime := f.Runtime(t, "test runtime", testutil.Cols{"owner_id": peer})
	own := f.Agent(t, "My offline agent", runtime, testutil.Cols{"owner_id": owner, "status": "offline", "instructions": "SECRET-INSTRUCTIONS", "custom_env": testutil.Raw(`'{"SECRET_ENV":"not-public"}'::jsonb`)})
	private := f.Agent(t, "Peer private", runtime, testutil.Cols{"owner_id": peer})
	shared := f.Agent(t, "Peer shared", runtime, testutil.Cols{"owner_id": peer, "permission_mode": "public_to"})
	f.Insert(t, "agent_invocation_target", testutil.Cols{"agent_id": shared, "target_type": "workspace", "target_id": f.WorkspaceID, "created_by": peer})
	unbound := f.Agent(t, "Needs runtime", "", testutil.Cols{"owner_id": owner})
	archived := f.Agent(t, "Archived selection", runtime, testutil.Cols{"owner_id": owner, "archived_at": testutil.Raw("now()")})
	team := f.Squad(t, "Private leader team", private)
	sharedTeam := f.Squad(t, "Shared leader team", shared)
	outside, _ := newPrincipalFixture(t)
	foreignRuntime := outside.Runtime(t, "outside runtime")
	foreignAgent := outside.Agent(t, "Outside leader", foreignRuntime)
	missingTeam := f.Squad(t, "Wrong-workspace leader", foreignAgent)
	query := CockpitAssigneeSelectorQuery{CockpitSurfaceQuery: CockpitSurfaceQuery{WorkspaceID: ws, ActorID: parseTestUUID(t, owner), Human: true}, PageSize: 100}
	page, err := svc.ListCockpitAssigneeChoices(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]CockpitAssigneeChoice{}
	for _, item := range page.Items {
		byID[item.ID] = item
	}
	for _, id := range []string{own, shared, sharedTeam, owner, peer} {
		if !byID[id].CanAssign {
			t.Fatalf("expected assignable %s: %+v", id, byID[id])
		}
	}
	for id, reason := range map[string]string{private: "invocation_denied", team: "invocation_denied", unbound: "runtime_unbound", missingTeam: "leader_missing"} {
		if item := byID[id]; item.CanAssign || item.Reason != reason {
			t.Fatalf("wrong eligibility %s: %+v", id, item)
		}
	}
	if _, found := byID[archived]; found {
		t.Fatal("archived actor appeared in search")
	}
	body, _ := json.Marshal(page)
	for _, secret := range []string{"SECRET-INSTRUCTIONS", "SECRET_ENV", "permission_agent", "runtime_config", "custom_env", "owner_id"} {
		if strings.Contains(string(body), secret) {
			t.Fatalf("selector leaked %s", secret)
		}
	}
	query.SelectedType, query.SelectedID = "agent", parseTestUUID(t, archived)
	selected, err := svc.ListCockpitAssigneeChoices(context.Background(), query)
	if err != nil || len(selected.Items) != 1 || selected.Items[0].CanAssign || selected.Items[0].Reason != "archived" || selected.Items[0].Status != "archived" {
		t.Fatalf("archived recovery: %+v/%v", selected, err)
	}
	if n := f.Count(t, "SELECT count(*) FROM agent_task_queue q JOIN agent a ON a.id=q.agent_id WHERE a.workspace_id=$1", ws); n != 0 {
		t.Fatalf("read selector enqueued %d tasks", n)
	}
}

func TestCockpitAssigneeChoicesPageAndSelectedScope(t *testing.T) {
	f, owner := newPrincipalFixture(t)
	svc := NewIssueService(f.q, f.Pool, f.svc.Bus, nil, f.svc.TaskSvc)
	for i := 0; i < 25; i++ {
		f.member(t, fmt.Sprintf("assignee-member-%02d", i))
	}
	p := CockpitAssigneeSelectorQuery{CockpitSurfaceQuery: CockpitSurfaceQuery{WorkspaceID: parseTestUUID(t, f.WorkspaceID), ActorID: parseTestUUID(t, owner), Human: true}, Kind: "member", PageSize: 20}
	first, err := svc.ListCockpitAssigneeChoices(context.Background(), p)
	if err != nil || first.Total != 26 || len(first.Items) != 20 || first.NextCursor == nil {
		t.Fatalf("first page: %+v/%v", first, err)
	}
	p.Cursor = *first.NextCursor
	second, err := svc.ListCockpitAssigneeChoices(context.Background(), p)
	if err != nil || len(second.Items) != 6 || second.NextCursor != nil {
		t.Fatalf("next page: %+v/%v", second, err)
	}
	seen := map[string]bool{}
	for _, item := range first.Items {
		seen[item.ID] = true
	}
	for _, item := range second.Items {
		if seen[item.ID] {
			t.Fatal("repeated assignee")
		}
	}
	p.Kind = "agent"
	if _, err := svc.ListCockpitAssigneeChoices(context.Background(), p); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("cursor crossed kinds: %v", err)
	}
	p.Cursor = ""
	p.Kind = "all"
	p.SelectedType = "member"
	p.SelectedID = parseTestUUID(t, second.Items[0].ID)
	exact, err := svc.ListCockpitAssigneeChoices(context.Background(), p)
	if err != nil || len(exact.Items) != 1 || exact.Items[0].ID != second.Items[0].ID {
		t.Fatalf("selected identity depended on first page: %+v/%v", exact, err)
	}
	p.Query = "ambiguous"
	if _, err := svc.ListCockpitAssigneeChoices(context.Background(), p); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("selected identity mixed with search: %v", err)
	}
	p.Query = ""
	p.SelectedID = pgtype.UUID{}
	if _, err := svc.ListCockpitAssigneeChoices(context.Background(), p); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("partial selected identity accepted: %v", err)
	}
}

type assigneeFailureStarter struct {
	TxStarter
	failure error
}

func (s assigneeFailureStarter) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return assigneeFailureTx{Tx: tx, failure: s.failure}, nil
}

type assigneeFailureTx struct {
	pgx.Tx
	failure error
}

func (t assigneeFailureTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if strings.Contains(sql, "name: ListAgentInvocationTargets") {
		return nil, t.failure
	}
	return t.Tx.Query(ctx, sql, args...)
}
func TestCockpitAssigneeChoicesDistinguishPermissionFailureFromDenial(t *testing.T) {
	f, owner := newPrincipalFixture(t)
	peer := f.member(t, "permission-peer")
	runtime := f.Runtime(t, "test runtime", testutil.Cols{"owner_id": peer})
	f.Agent(t, "Shared permission lookup", runtime, testutil.Cols{"owner_id": peer, "permission_mode": "public_to"})
	failure := errors.New("invocation target lookup unavailable")
	svc := NewIssueService(f.q, assigneeFailureStarter{TxStarter: f.Pool, failure: failure}, f.svc.Bus, nil, f.svc.TaskSvc)
	_, err := svc.ListCockpitAssigneeChoices(context.Background(), CockpitAssigneeSelectorQuery{CockpitSurfaceQuery: CockpitSurfaceQuery{WorkspaceID: parseTestUUID(t, f.WorkspaceID), ActorID: parseTestUUID(t, owner)}, Kind: "agent"})
	if !errors.Is(err, failure) {
		t.Fatalf("read failure became a permission verdict: %v", err)
	}
}
