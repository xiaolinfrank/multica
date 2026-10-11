package handler

import (
	"context"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestCockpitInputHTTPManifestRunUsesRealPrincipalAndExactClaim(t *testing.T) {
	ws := dbfx.Workspace(t, "Input Run transport", "input-run-http-"+uuid.NewString())
	dbfx.Cleanup(t, "DELETE FROM search_index_change WHERE workspace_id=$1", ws)
	dbfx.Member(t, ws, testUserID, "owner")
	runtime := dbfx.Runtime(t, "Input HTTP runtime", testutil.Cols{"workspace_id": ws, "owner_id": testUserID, "status": "online", "daemon_id": "input-http-daemon", "metadata": testutil.Raw(`'{"capabilities":["fixed_input_manifest_v1"]}'::jsonb`)})
	agent := dbfx.Agent(t, "Input HTTP Agent", runtime, testutil.Cols{"workspace_id": ws, "owner_id": testUserID, "status": "idle", "permission_mode": "private"})
	issue := dbfx.Issue(t, "Input HTTP Issue", testutil.Cols{"workspace_id": ws, "creator_id": testUserID, "assignee_id": agent, "assignee_type": "agent"})
	dbfx.Cleanup(t, "DELETE FROM cockpit_issue_input_manifest_version WHERE workspace_id=$1", ws)
	dbfx.Cleanup(t, "DELETE FROM cockpit_issue_input_manifest_item WHERE workspace_id=$1", ws)
	dbfx.Cleanup(t, "DELETE FROM cockpit_issue_input_manifest WHERE workspace_id=$1", ws)
	dbfx.Cleanup(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", issue)
	h := *testHandler
	h.IssueService = &service.IssueService{Queries: h.Queries, TxStarter: testPool, TaskService: h.TaskService, CockpitInputBackendReady: true, CockpitRunInputManifestBackendReady: true}
	key := uuid.NewString()
	save := testutil.WithURLParams(cockpitRequest(http.MethodPut, "/api/cockpit/issues/"+issue+"/input-manifest", ws, map[string]any{"command_key": key, "expected_revision": 0, "items": []any{}, "note": "  exact note\n"}), "issueId", issue)
	var fixed service.CockpitInputManifestResult
	testutil.Call(t, cockpitHandler(h.SaveCockpitInputManifest), save).Want(200).JSON(&fixed)
	if fixed.Receipt.Note != "  exact note\n" || fixed.Current == nil || fixed.Current.Revision != 1 {
		t.Fatalf("fixed confirmation lost identity/body: %+v", fixed)
	}
	rerun := func(expected any) *http.Request {
		return testutil.WithURLParams(cockpitRequest(http.MethodPost, "/api/issues/"+issue+"/rerun", ws, map[string]any{"expected_input_manifest_version_id": expected}), "id", issue)
	}
	testutil.Call(t, cockpitHandler(h.RerunIssue), rerun(nil)).Want(409)
	if dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue) != 0 {
		t.Fatal("stale explicit-null authorization enqueued execution")
	}
	var queued AgentTaskResponse
	testutil.Call(t, cockpitHandler(h.RerunIssue), rerun(fixed.Receipt.ManifestVersionID)).Want(202).JSON(&queued)
	if queued.InputManifestVersionID == nil || *queued.InputManifestVersionID != fixed.Receipt.ManifestVersionID || queued.InputPreparationState != "pending" {
		t.Fatalf("Run wire lost its fixed input pin: %+v", queued)
	}
	claimed, err := h.Queries.ClaimAgentTask(context.Background(), db.ClaimAgentTaskParams{AgentID: parseUUID(agent), RuntimeID: parseUUID(runtime), PrepareLeaseSecs: 45, RuntimeStaleSecs: 150, SupportsFixedInputManifests: true})
	if err != nil {
		t.Fatal(err)
	}
	stamp := claimed.DispatchedAt.Time.UTC().Format(time.RFC3339Nano)
	request := func(method, path string, body any) *http.Request {
		r := testutil.JSONRequest(method, path, body)
		r = r.WithContext(middleware.WithDaemonContext(r.Context(), ws, "input-http-daemon"))
		r.Header.Set("X-User-ID", uuid.NewString()) // Cannot replace the credential owner.
		return testutil.WithURLParams(r, "taskId", queued.ID)
	}
	startBody := map[string]any{"runtime_id": runtime, "dispatched_at": stamp, "capabilities": []string{service.CockpitFixedInputManifestCapability}}
	testutil.Call(t, h.StartTask, request(http.MethodPost, "/api/tasks/"+queued.ID+"/start", startBody)).Want(409)
	query := url.Values{"runtime_id": {runtime}, "dispatched_at": {stamp}}
	var run service.CockpitRunInputManifest
	testutil.Call(t, h.GetCockpitRunInputManifest, request(http.MethodGet, "/api/tasks/"+queued.ID+"/input-manifest?"+query.Encode(), nil)).Want(200).JSON(&run)
	if run.ManifestVersion == nil || run.ManifestVersion.ID != fixed.Receipt.ManifestVersionID || !run.RuntimeSupported {
		t.Fatalf("exact claim metadata: %+v", run)
	}
	ack := service.CockpitRunInputPreparationInput{ManifestVersionID: fixed.Receipt.ManifestVersionID, ManifestHash: fixed.Receipt.ManifestHash, DispatchedAt: stamp, State: "required_ready", PreparedInputVersionIDs: []string{}}
	testutil.Call(t, h.RecordCockpitRunInputPreparation, request(http.MethodPost, "/api/tasks/"+queued.ID+"/input-preparation?runtime_id="+runtime, ack)).Want(200).JSON(&run)
	if run.PreparationState != "required_ready" {
		t.Fatalf("explicit empty fixed set was not confirmed: %+v", run)
	}
	testutil.Call(t, h.StartTask, request(http.MethodPost, "/api/tasks/"+queued.ID+"/start", startBody)).Want(200)
	wrong := request(http.MethodGet, "/api/tasks/"+queued.ID+"/input-manifest?"+query.Encode(), nil)
	wrong = wrong.WithContext(middleware.WithDaemonContext(wrong.Context(), ws, "another-daemon"))
	testutil.Call(t, h.GetCockpitRunInputManifest, wrong).Want(403)
}

func TestCockpitInputHTTPStartBindsAuthenticatedCredentialOwner(t *testing.T) {
	ws := dbfx.Workspace(t, "Input Run transport", "input-start-owner-"+uuid.NewString())
	dbfx.Cleanup(t, "DELETE FROM search_index_change WHERE workspace_id=$1", ws)
	dbfx.Member(t, ws, testUserID, "owner")
	runtime := dbfx.Runtime(t, "Input HTTP runtime", testutil.Cols{"workspace_id": ws, "owner_id": testUserID, "status": "online", "daemon_id": "input-http-daemon", "metadata": testutil.Raw(`'{"capabilities":["fixed_input_manifest_v1"]}'::jsonb`)})
	agent := dbfx.Agent(t, "Input HTTP Agent", runtime, testutil.Cols{"workspace_id": ws, "owner_id": testUserID, "status": "idle", "permission_mode": "private"})
	issue := dbfx.Issue(t, "Input HTTP Issue", testutil.Cols{"workspace_id": ws, "creator_id": testUserID, "assignee_id": agent, "assignee_type": "agent"})
	dbfx.Cleanup(t, "DELETE FROM cockpit_issue_input_manifest_version WHERE workspace_id=$1", ws)
	dbfx.Cleanup(t, "DELETE FROM cockpit_issue_input_manifest_item WHERE workspace_id=$1", ws)
	dbfx.Cleanup(t, "DELETE FROM cockpit_issue_input_manifest WHERE workspace_id=$1", ws)
	dbfx.Cleanup(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", issue)
	h := *testHandler
	h.IssueService = &service.IssueService{Queries: h.Queries, TxStarter: testPool, TaskService: h.TaskService, CockpitInputBackendReady: true, CockpitRunInputManifestBackendReady: true}
	key := uuid.NewString()
	save := testutil.WithURLParams(cockpitRequest(http.MethodPut, "/api/cockpit/issues/"+issue+"/input-manifest", ws, map[string]any{"command_key": key, "expected_revision": 0, "items": []any{}, "note": "  exact note\n"}), "issueId", issue)
	var fixed service.CockpitInputManifestResult
	testutil.Call(t, cockpitHandler(h.SaveCockpitInputManifest), save).Want(200).JSON(&fixed)
	if fixed.Receipt.Note != "  exact note\n" || fixed.Current == nil || fixed.Current.Revision != 1 {
		t.Fatalf("fixed confirmation lost identity/body: %+v", fixed)
	}
	rerun := func(expected any) *http.Request {
		return testutil.WithURLParams(cockpitRequest(http.MethodPost, "/api/issues/"+issue+"/rerun", ws, map[string]any{"expected_input_manifest_version_id": expected}), "id", issue)
	}
	testutil.Call(t, cockpitHandler(h.RerunIssue), rerun(nil)).Want(409)
	if dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue) != 0 {
		t.Fatal("stale explicit-null authorization enqueued execution")
	}
	var queued AgentTaskResponse
	testutil.Call(t, cockpitHandler(h.RerunIssue), rerun(fixed.Receipt.ManifestVersionID)).Want(202).JSON(&queued)
	if queued.InputManifestVersionID == nil || *queued.InputManifestVersionID != fixed.Receipt.ManifestVersionID || queued.InputPreparationState != "pending" {
		t.Fatalf("Run wire lost its fixed input pin: %+v", queued)
	}
	claimed, err := h.Queries.ClaimAgentTask(context.Background(), db.ClaimAgentTaskParams{AgentID: parseUUID(agent), RuntimeID: parseUUID(runtime), PrepareLeaseSecs: 45, RuntimeStaleSecs: 150, SupportsFixedInputManifests: true})
	if err != nil {
		t.Fatal(err)
	}
	stamp := claimed.DispatchedAt.Time.UTC().Format(time.RFC3339Nano)
	ack := service.CockpitRunInputPreparationInput{ManifestVersionID: fixed.Receipt.ManifestVersionID, ManifestHash: fixed.Receipt.ManifestHash, DispatchedAt: stamp, State: "required_ready", PreparedInputVersionIDs: []string{}}
	principal := service.CockpitInputQuery{CockpitInputRead: service.CockpitInputRead{WorkspaceID: parseUUID(ws), CredentialOwnerID: parseUUID(testUserID), AgentID: parseUUID(agent), RunID: claimed.ID, RuntimeID: claimed.RuntimeID, ClaimDispatchedAt: claimed.DispatchedAt, ActorSource: "daemon_claim"}, TaskID: claimed.ID}
	if _, err := h.IssueService.RecordCockpitRunInputPreparation(context.Background(), principal, ack); err != nil {
		t.Fatal(err)
	}
	other := dbfx.User(t, "Other workspace member", uuid.NewString()+"@example.test")
	dbfx.Member(t, ws, other, "member")
	startBody := map[string]any{"runtime_id": runtime, "dispatched_at": stamp, "capabilities": []string{service.CockpitFixedInputManifestCapability}, "credential_owner_id": testUserID}
	for _, source := range []string{"member", "cloud_pat"} {
		t.Run(source, func(t *testing.T) {
			r := testutil.WithURLParams(cockpitRequest(http.MethodPost, "/api/tasks/"+queued.ID+"/start", ws, startBody), "taskId", queued.ID)
			r.Header.Set("X-User-ID", other)
			r.Header.Set("X-Actor-Source", source)
			testutil.Call(t, h.StartTask, r).Want(http.StatusForbidden)
			current, err := h.Queries.GetAgentTask(context.Background(), claimed.ID)
			if err != nil || current.Status != "dispatched" || current.StartedAt.Valid {
				t.Fatalf("foreign credential started the prepared claim: %+v %v", current, err)
			}
		})
	}
	r := testutil.WithURLParams(cockpitRequest(http.MethodPost, "/api/tasks/"+queued.ID+"/start", ws, startBody), "taskId", queued.ID)
	r.Header.Set("X-Actor-Source", "cloud_pat")
	testutil.Call(t, h.StartTask, r).Want(http.StatusOK)
}
