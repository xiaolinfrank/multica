package handler

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestCockpitCreationNodeKeyReplaysOriginalAndCannotResurrect(t *testing.T) {
	ws := cockpitFixture(t, "keyed node")
	key := uuid.NewString()
	body := map[string]any{"code": "L1-01", "name": "Original", "creation_key": key}
	var first, replay CockpitNodeCreateResponse
	call := func(body any) *testutil.Response {
		return testutil.Call(t, cockpitHandler(testHandler.CreateCockpitNode), cockpitRequest("POST", "/api/cockpit/nodes", ws, body))
	}
	call(body).Want(201).JSON(&first)
	if first.CreationKey != key || first.Replayed || first.WorkspaceID != ws {
		t.Fatalf("initial receipt: %+v", first)
	}
	dbfx.Exec(t, "UPDATE cockpit_node SET name='Edited' WHERE workspace_id=$1 AND id=$2", ws, first.ID)
	call(body).Want(200).JSON(&replay)
	if !replay.Replayed || replay.ID != first.ID || replay.Name != "Original" || replay.CreationKey != key {
		t.Fatalf("immutable receipt lost: %+v", replay)
	}
	call(map[string]any{"code": "L1-01", "name": "Different", "creation_key": key}).Want(409)
	other := dbfx.User(t, "Other creator", "creation-other-"+uuid.NewString()+"@example.test")
	dbfx.Member(t, ws, other, "member")
	req := cockpitRequest("POST", "/api/cockpit/nodes", ws, body)
	req.Header.Set("X-User-ID", other)
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitNode), req).Want(409)
	dbfx.Exec(t, "DELETE FROM cockpit_node WHERE workspace_id=$1", ws)
	dbfx.Exec(t, "DELETE FROM cockpit WHERE workspace_id=$1", ws)
	call(body).Want(410)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1", ws) != 0 || dbfx.Count(t, "SELECT count(*) FROM cockpit_creation_intent WHERE workspace_id=$1", ws) != 1 {
		t.Fatal("deleted creation was resurrected or its receipt lost")
	}
}

func TestCockpitCreationMeetingKeyPrecedesMutableAnchorAndAllocation(t *testing.T) {
	ws := cockpitMeetingFixture(t, "keyed meeting")
	node := createNode(t, ws, map[string]any{"code": "L1-01"})
	key := uuid.NewString()
	body := map[string]any{"title": "Review", "meet_date": "2026-10-10", "node_id": node.ID, "creation_key": key}
	call := func(body any) *testutil.Response {
		return testutil.Call(t, cockpitHandler(testHandler.CreateCockpitMeeting), cockpitRequest("POST", "/api/cockpit/meetings", ws, body))
	}
	var first, replay CockpitMeetingCreateResponse
	call(body).Want(201).JSON(&first)
	if first.Code != "20261010-01" || first.NodeLink == nil || first.NodeLink.NodeID != node.ID || first.Replayed || first.CreationKey != key || first.WorkspaceID != ws {
		t.Fatalf("creation/anchor receipt: %+v", first)
	}
	dbfx.Exec(t, "UPDATE cockpit_meeting SET title='Edited later' WHERE workspace_id=$1 AND id=$2", ws, first.ID)
	dbfx.Exec(t, "DELETE FROM cockpit_meeting_node WHERE workspace_id=$1", ws)
	dbfx.Exec(t, "DELETE FROM cockpit_node WHERE workspace_id=$1", ws)
	call(body).Want(200).JSON(&replay)
	if !replay.Replayed || replay.ID != first.ID || replay.Title != "Review" || replay.Code != first.Code || replay.NodeLink == nil {
		t.Fatalf("replay consulted changed anchor or reallocated number: %+v", replay)
	}
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_node WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("replay restored a removed anchor")
	}
	call(map[string]any{"title": "Other", "meet_date": "2026-10-10", "creation_key": key}).Want(409)
	dbfx.Exec(t, "DELETE FROM cockpit_meeting WHERE workspace_id=$1", ws)
	call(body).Want(410)
}

func TestCockpitCreationConcurrentKeyCreatesOneResourceAndReceipt(t *testing.T) {
	for _, kind := range []string{"node", "meeting"} {
		t.Run(kind, func(t *testing.T) {
			ws := cockpitFixture(t, "concurrent "+kind)
			key := uuid.NewString()
			body := map[string]any{"creation_key": key}
			handler := testHandler.CreateCockpitNode
			table := "cockpit_node"
			if kind == "node" {
				body["auto_code"] = true
				body["name"] = "Concurrent"
			} else {
				body["title"] = "Concurrent"
				body["meet_date"] = "2026-10-10"
				handler = testHandler.CreateCockpitMeeting
				table = "cockpit_meeting"
			}
			var wg sync.WaitGroup
			ids := make(chan string, 4)
			for range 4 {
				wg.Add(1)
				go func() {
					defer wg.Done()
					var receipt struct {
						ID          string `json:"id"`
						CreationKey string `json:"creation_key"`
					}
					out := testutil.Call(t, cockpitHandler(handler), cockpitRequest("POST", "/create", ws, body))
					if out.Code != http.StatusCreated && out.Code != http.StatusOK {
						t.Errorf("concurrent create status=%d body=%s", out.Code, out.Body.String())
						return
					}
					out.JSON(&receipt)
					if receipt.CreationKey != key {
						t.Errorf("missing key: %+v", receipt)
					}
					ids <- receipt.ID
				}()
			}
			wg.Wait()
			close(ids)
			first := ""
			for id := range ids {
				if first == "" {
					first = id
				}
				if id != first {
					t.Fatalf("one key minted distinct IDs: %s/%s", first, id)
				}
			}
			if first == "" || dbfx.Count(t, "SELECT count(*) FROM "+table+" WHERE workspace_id=$1", ws) != 1 || dbfx.Count(t, "SELECT count(*) FROM cockpit_creation_intent WHERE workspace_id=$1", ws) != 1 {
				t.Fatal("create and receipt did not commit exactly once")
			}
		})
	}
}

func TestCockpitCreationFailureRollsBackReceiptAndBoard(t *testing.T) {
	ws := cockpitFixture(t, "failed keyed creation")
	key := uuid.NewString()
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitMeeting), cockpitRequest("POST", "/create", ws, map[string]any{"creation_key": key, "title": "Invalid anchor", "node_id": uuid.NewString()})).Want(404)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1", ws) != 0 || dbfx.Count(t, "SELECT count(*) FROM cockpit_creation_intent WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("failed command left a board or creation receipt")
	}
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitMeeting), cockpitRequest("POST", "/create", ws, map[string]any{"creation_key": key, "title": "Valid"})).Want(201)
}

func TestCockpitCreationImportPreservesGoneKeyAndWorkspaceDeletesLedger(t *testing.T) {
	ws := cockpitFixture(t, "receipt through import")
	body := map[string]any{"code": "L1-01", "name": "Original", "creation_key": uuid.NewString()}
	var original CockpitNodeCreateResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitNode), cockpitRequest("POST", "/nodes", ws, body)).Want(201).JSON(&original)
	testutil.Call(t, cockpitHandler(testHandler.ImportCockpit), cockpitRequest("POST", "/import", ws, map[string]any{"nodes": []map[string]any{{"code": "L1-01", "name": "Restored code"}}})).Want(200)
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitNode), cockpitRequest("POST", "/nodes", ws, body)).Want(410)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_creation_intent WHERE workspace_id=$1", ws) != 1 || dbfx.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1", ws) != 1 {
		t.Fatal("import lost receipt or replay created another node")
	}
	testutil.Call(t, testHandler.DeleteWorkspace, testutil.WithURLParams(cockpitRequest("DELETE", "/api/workspaces/"+ws, ws, nil), "id", ws)).Want(204)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_creation_intent WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("workspace deletion retained creation receipts")
	}
}

type rejectCreationReceiptStarter struct {
	base interface {
		Begin(context.Context) (pgx.Tx, error)
	}
}

func (s rejectCreationReceiptStarter) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, e := s.base.Begin(ctx)
	if e != nil {
		return nil, e
	}
	return rejectCreationReceiptTx{Tx: tx}, nil
}

type rejectCreationReceiptTx struct{ pgx.Tx }

func (tx rejectCreationReceiptTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	if strings.Contains(sql, "INSERT INTO cockpit_creation_intent") {
		return pgconn.CommandTag{}, errors.New("injected receipt persistence failure")
	}
	return tx.Tx.Exec(ctx, sql, args...)
}
func TestCockpitCreationReceiptFailureRollsBackResource(t *testing.T) {
	ws := cockpitFixture(t, "receipt rollback")
	h := &Handler{Queries: testHandler.Queries, TxStarter: rejectCreationReceiptStarter{base: testHandler.TxStarter}}
	command := &cockpitCreationCommand{WorkspaceID: parseUUID(ws), ActorID: parseUUID(testUserID), Key: parseUUID(uuid.NewString()), Kind: "meeting", Hash: "test-hash"}
	_, err := h.createCockpitMeetingRecord(context.Background(), db.CreateCockpitMeetingParams{WorkspaceID: parseUUID(ws), Title: "Must roll back"}, false, pgtype.UUID{}, command)
	if err == nil || !strings.Contains(err.Error(), "injected") {
		t.Fatalf("expected receipt failure: %v", err)
	}
	for _, table := range []string{"cockpit", "cockpit_meeting", "cockpit_creation_intent"} {
		if dbfx.Count(t, "SELECT count(*) FROM "+table+" WHERE workspace_id=$1", ws) != 0 {
			t.Fatalf("receipt failure left %s", table)
		}
	}
}

func TestCockpitCreationRechecksMembershipInsideWriteTransaction(t *testing.T) {
	ws := cockpitFixture(t, "removed creation member")
	dbfx.Exec(t, "DELETE FROM member WHERE workspace_id=$1 AND user_id=$2", ws, testUserID)
	command := &cockpitCreationCommand{WorkspaceID: parseUUID(ws), ActorID: parseUUID(testUserID), Kind: "node"}
	_, _, _, _, err := testHandler.beginCockpitCreation(context.Background(), parseUUID(ws), pgtype.UUID{}, command)
	var denied *cockpitCreationFailure
	if !errors.As(err, &denied) || denied.status != 404 {
		t.Fatalf("stale prechecked actor reached creation: %v", err)
	}
	if dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("removed member initialized a board")
	}
}

func TestCockpitCreationAutoCodesSerializeDistinctKeys(t *testing.T) {
	ws := cockpitFixture(t, "auto node allocation")
	var wg sync.WaitGroup
	codes := make(chan string, 4)
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var out CockpitNodeCreateResponse
			testutil.Call(t, cockpitHandler(testHandler.CreateCockpitNode), cockpitRequest("POST", "/nodes", ws, map[string]any{"auto_code": true, "creation_key": uuid.NewString(), "name": "Independent"})).Want(201).JSON(&out)
			codes <- out.Code
		}()
	}
	wg.Wait()
	close(codes)
	seen := map[string]bool{}
	for code := range codes {
		if code == "" || seen[code] {
			t.Fatalf("auto allocation repeated code %q", code)
		}
		seen[code] = true
	}
	if len(seen) != 4 || dbfx.Count(t, "SELECT count(*) FROM cockpit_creation_intent WHERE workspace_id=$1", ws) != 4 {
		t.Fatal("distinct requests were collapsed or lost")
	}
	for _, body := range []map[string]any{{"auto_code": true, "name": "Missing key"}, {"auto_code": true, "creation_key": uuid.NewString(), "code": "L1-99"}} {
		testutil.Call(t, cockpitHandler(testHandler.CreateCockpitNode), cockpitRequest("POST", "/nodes", ws, body)).Want(400)
	}
}

func TestCockpitCreationBindingConflictPointsToExistingScopedNode(t *testing.T) {
	ws := cockpitFixture(t, "existing binding recovery")
	project := dbfx.Project(t, "Existing project", testutil.Cols{"workspace_id": ws})
	existing := createNode(t, ws, map[string]any{"code": "L1-01", "project_id": project})
	key := uuid.NewString()
	var body map[string]any
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitNode), cockpitRequest("POST", "/nodes", ws, map[string]any{"auto_code": true, "creation_key": key, "project_id": project})).Want(409).JSON(&body)
	// Keep product assertions on the actual wire keys.
	if body["code"] != "node_binding_exists" || body["workspace_id"] != ws || body["creation_key"] != key || body["existing_node_id"] != existing.ID {
		t.Fatalf("unsafe binding repair receipt: %+v", body)
	}
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_creation_intent WHERE workspace_id=$1", ws) != 0 || dbfx.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1", ws) != 1 {
		t.Fatal("conflict committed a new node or creation receipt")
	}
}
