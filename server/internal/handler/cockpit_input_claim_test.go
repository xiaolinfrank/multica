package handler

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestCockpitInputHTTPDaemonClaimRequiresActualRuntimeAndDispatch(t *testing.T) {
	ws := dbfx.Workspace(t, "Input claim", "input-claim-"+uuid.NewString())
	dbfx.Cleanup(t, "DELETE FROM search_index_change WHERE workspace_id=$1", ws)
	owner := dbfx.User(t, "Runtime credential owner", uuid.NewString()+"@example.test")
	originator := dbfx.User(t, "Original authorizer", uuid.NewString()+"@example.test")
	dbfx.Member(t, ws, owner, "member")
	dbfx.Member(t, ws, originator, "owner")
	runtime := dbfx.Runtime(t, "Bound runtime", testutil.Cols{"workspace_id": ws, "owner_id": owner, "daemon_id": "input-test-daemon"})
	otherRuntime := dbfx.Runtime(t, "Other daemon, same owner", testutil.Cols{"workspace_id": ws, "owner_id": owner, "daemon_id": "another-daemon"})
	agent := dbfx.Agent(t, "Input agent", runtime, testutil.Cols{"workspace_id": ws, "owner_id": originator})
	issue := dbfx.Issue(t, "Inputs for this task", testutil.Cols{"workspace_id": ws})
	dispatched := time.Now().UTC().Truncate(time.Microsecond)
	task := dbfx.Task(t, agent, testutil.Cols{"issue_id": issue, "runtime_id": runtime, "status": "dispatched", "dispatched_at": dispatched, "originator_user_id": originator, "accountable_user_id": originator})
	foreign := dbfx.Workspace(t, "Other input claim", "input-claim-other-"+uuid.NewString())
	for _, c := range []struct {
		name, requestedRuntime, daemonWS, daemonID, time string
		status                                           int
	}{
		{"precise claim", runtime, ws, "input-test-daemon", dispatched.Format(time.RFC3339Nano), 200},
		{"same owner different runtime", otherRuntime, ws, "input-test-daemon", dispatched.Format(time.RFC3339Nano), 403},
		{"wrong task dispatch", runtime, ws, "input-test-daemon", dispatched.Add(time.Second).Format(time.RFC3339Nano), 409},
		{"foreign daemon workspace", runtime, foreign, "input-test-daemon", dispatched.Format(time.RFC3339Nano), 404},
	} {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/", nil)
			req = req.WithContext(middleware.WithDaemonContext(req.Context(), c.daemonWS, c.daemonID))
			req.Header.Set("X-User-ID", originator)
			q := service.CockpitInputQuery{CockpitInputRead: service.CockpitInputRead{WorkspaceID: parseUUID(ws), ActorSource: "daemon_claim"}}
			rec := httptest.NewRecorder()
			ok := testHandler.cockpitInputClaim(rec, req, &q, task, c.requestedRuntime, c.time)
			if c.status == 200 {
				if !ok || q.CredentialOwnerID != parseUUID(owner) || q.RunID != parseUUID(task) || q.RuntimeID != parseUUID(runtime) || q.ActorSource != "daemon_claim" || q.TrustedDaemonID != "input-test-daemon" {
					t.Fatalf("wrong trusted principal: ok=%v q=%+v body=%s", ok, q, rec.Body.String())
				}
			} else if ok || rec.Code != c.status {
				t.Fatalf("ok=%v status=%d want=%d body=%s", ok, rec.Code, c.status, rec.Body.String())
			}
		})
	}
}
