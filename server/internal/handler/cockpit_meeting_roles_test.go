package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/testutil"
)

type meetingQueryFailureStarter struct {
	base txStarter
	name string
}

func (s meetingQueryFailureStarter) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.base.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return meetingQueryFailureTx{Tx: tx, name: s.name}, nil
}

type meetingQueryFailureTx struct {
	pgx.Tx
	name string
}

func (tx meetingQueryFailureTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if strings.Contains(sql, "-- name: "+tx.name+" ") {
		return nil, errors.New("injected meeting query failure")
	}
	return tx.Tx.Query(ctx, sql, args...)
}

func (tx meetingQueryFailureTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if strings.Contains(sql, "-- name: "+tx.name+" ") {
		return meetingQueryFailureRow{}
	}
	return tx.Tx.QueryRow(ctx, sql, args...)
}

type meetingQueryFailureRow struct{}

func (meetingQueryFailureRow) Scan(...any) error { return errors.New("injected meeting query failure") }

func TestCockpitMeetingRolesReadFailureRollsBack(t *testing.T) {
	ws := cockpitMeetingFixture(t, "Read-back failure")
	issue := dbfx.Issue(t, "Review", testutil.Cols{"workspace_id": ws})
	meeting := createMeeting(t, ws, map[string]any{"title": "Review"})
	setMeetingIssues(t, ws, meeting.ID, map[string]any{"issue_ids": []string{issue}}).Want(http.StatusOK)
	setMeetingRoles(t, ws, meeting.ID, issue, map[string]any{"roles": []string{"preparation"}}).Want(http.StatusOK)
	h := *testHandler
	h.TxStarter = meetingQueryFailureStarter{base: testHandler.TxStarter, name: "ListCockpitMeetingIssues"}
	testutil.Call(t, cockpitHandler(h.SetCockpitMeetingIssueRoles), testutil.WithURLParams(
		cockpitRequest(http.MethodPut, "/api/cockpit/meetings/"+meeting.ID+"/issues/"+issue+"/roles", ws,
			map[string]any{"roles": []string{"review"}}), "meetingId", meeting.ID, "issueId", issue,
	)).Want(http.StatusInternalServerError)
	links := getBoard(t, ws).MeetingIssues
	if len(links) != 1 || !reflect.DeepEqual(links[0].Roles, []string{"preparation"}) {
		t.Fatalf("failed read-back must not clear or commit relation changes: %+v", links)
	}
}

func TestCockpitMeetingProvisionLinkFailureRollsBackIssue(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Atomic provision failure", true)
	meeting := createMeeting(t, f.wsID, map[string]any{"title": "Minutes"})
	h := *testHandler
	svc := *testHandler.IssueService
	svc.TxStarter = meetingQueryFailureStarter{base: testHandler.TxStarter, name: "CreateCockpitMeetingIssue"}
	h.IssueService = &svc
	body := map[string]any{
		"project_id": f.project, "module_id": f.module, "node_id": f.node,
		"create_task": true, "create_dir": false, "remember": false,
	}
	var failed CockpitMeetingProvisionResponse
	testutil.Call(t, cockpitHandler(h.ProvisionCockpitMeeting), testutil.WithURLParams(
		cockpitRequest(http.MethodPost, "/api/cockpit/meetings/"+meeting.ID+"/provision", f.wsID, body),
		"meetingId", meeting.ID,
	)).Want(http.StatusOK).JSON(&failed)
	if failed.Task != nil || failed.TaskError == "" {
		t.Fatalf("expected a reported task failure: %+v", failed)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id = $1", f.wsID); n != 0 {
		t.Fatalf("failed linking left %d orphaned issues", n)
	}
	retried := f.provision(t, meeting.ID, body)
	if retried.Task == nil || retried.TaskError != "" {
		t.Fatalf("retry failed: %+v", retried)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id = $1", f.wsID); n != 1 {
		t.Fatalf("retry created %d issues, want exactly one", n)
	}
}

func TestNormalizeCockpitMeetingRoles(t *testing.T) {
	for _, tc := range []struct {
		name     string
		values   []string
		existing []string
		want     []string
		bad      bool
	}{
		{name: "multiple purposes", values: []string{"review", "preparation", "review"}, want: []string{"preparation", "review"}},
		{name: "clear", values: []string{}, want: []string{}},
		{name: "missing", bad: true},
		{name: "invalid new purpose", values: []string{"approve_everything"}, bad: true},
		{name: "preserve future purpose", values: []string{"future", "review"}, existing: []string{"future"}, want: []string{"future", "review"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeCockpitMeetingRoles(tc.values, tc.existing)
			if (err != nil) != tc.bad {
				t.Fatalf("error = %v, want error %v", err, tc.bad)
			}
			if !tc.bad && !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("purposes = %v, want %v", got, tc.want)
			}
		})
	}
}

func setMeetingRoles(t *testing.T, wsID, meetingID, issueID string, body map[string]any) *testutil.Response {
	t.Helper()
	return testutil.Call(t, cockpitHandler(testHandler.SetCockpitMeetingIssueRoles), testutil.WithURLParams(
		cockpitRequest(http.MethodPut, "/api/cockpit/meetings/"+meetingID+"/issues/"+issueID+"/roles", wsID, body),
		"meetingId", meetingID, "issueId", issueID,
	))
}

func TestCockpitMeetingIssuePurposesSurviveLegacyReplacement(t *testing.T) {
	ws := cockpitMeetingFixture(t, "Meeting purposes")
	issue := dbfx.Issue(t, "Prepare and review", testutil.Cols{"workspace_id": ws})
	other := dbfx.Issue(t, "Reference", testutil.Cols{"workspace_id": ws})
	meeting := createMeeting(t, ws, map[string]any{"title": "Scope review"})
	setMeetingIssues(t, ws, meeting.ID, map[string]any{"issue_ids": []string{issue, other}}).Want(http.StatusOK)
	dbfx.Exec(t, "UPDATE cockpit_meeting_issue SET role = 'task' WHERE meeting_id = $1 AND issue_id = $2", meeting.ID, issue)
	var updated meetingLinksResponse
	setMeetingRoles(t, ws, meeting.ID, "TES-1", map[string]any{"roles": []string{"review", "preparation"}}).
		Want(http.StatusOK).JSON(&updated)
	if len(updated.Links) != 2 {
		t.Fatalf("response must retain all meeting links: %+v", updated)
	}
	setMeetingIssues(t, ws, meeting.ID, map[string]any{"issue_ids": []string{issue}, "replace": true}).Want(http.StatusOK)
	board := getBoard(t, ws)
	if len(board.MeetingIssues) != 1 || board.MeetingIssues[0].Role != "task" ||
		!reflect.DeepEqual(board.MeetingIssues[0].Roles, []string{"preparation", "review"}) {
		t.Fatalf("replacement erased provenance or purposes: %+v", board.MeetingIssues)
	}
	setMeetingRoles(t, ws, meeting.ID, issue, map[string]any{"roles": []string{}}).Want(http.StatusOK)
	board = getBoard(t, ws)
	if board.MeetingIssues[0].Roles == nil || len(board.MeetingIssues[0].Roles) != 0 || board.MeetingIssues[0].Role != "task" {
		t.Fatalf("clear must return an empty array and preserve the provisioning marker: %+v", board.MeetingIssues)
	}
}

func TestCockpitMeetingIssuePurposesRejectForeignAndMissingLinks(t *testing.T) {
	ws := cockpitMeetingFixture(t, "Purpose boundaries")
	meeting := createMeeting(t, ws, map[string]any{"title": "Review"})
	unlinked := dbfx.Issue(t, "Not linked", testutil.Cols{"workspace_id": ws})
	foreign := dbfx.Issue(t, "Other workspace")
	for _, issue := range []string{unlinked, foreign} {
		setMeetingRoles(t, ws, meeting.ID, issue, map[string]any{"roles": []string{"review"}}).Want(http.StatusNotFound)
	}
	setMeetingIssues(t, ws, meeting.ID, map[string]any{"issue_ids": []string{unlinked}}).Want(http.StatusOK)
	for _, body := range []map[string]any{{}, {"roles": nil}, {"roles": []string{"task"}}, {"roles": "review"}} {
		setMeetingRoles(t, ws, meeting.ID, unlinked, body).Want(http.StatusBadRequest)
	}
	if got := getBoard(t, ws).MeetingIssues[0].Roles; len(got) != 0 {
		t.Fatalf("invalid requests changed the link: %v", got)
	}
}

func TestCockpitMeetingIssuePurposesSnapshotRoundTrip(t *testing.T) {
	ws := cockpitMeetingFixture(t, "Purpose versions")
	issue := dbfx.Issue(t, "Follow-up", testutil.Cols{"workspace_id": ws})
	meeting := createMeeting(t, ws, map[string]any{"title": "Decisions"})
	setMeetingIssues(t, ws, meeting.ID, map[string]any{"issue_ids": []string{issue}}).Want(http.StatusOK)
	setMeetingRoles(t, ws, meeting.ID, issue, map[string]any{"roles": []string{"action", "reference"}}).Want(http.StatusOK)
	var snapshot CockpitSnapshotResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitSnapshot), cockpitRequest(http.MethodPost,
		"/api/cockpit/snapshots", ws, map[string]any{"label": "Purposes"})).Want(http.StatusCreated).JSON(&snapshot)
	setMeetingRoles(t, ws, meeting.ID, issue, map[string]any{"roles": []string{"review"}}).Want(http.StatusOK)
	restoreSnapshot(t, ws, snapshot.ID).Want(http.StatusOK)
	links := getBoard(t, ws).MeetingIssues
	if len(links) != 1 || !reflect.DeepEqual(links[0].Roles, []string{"action", "reference"}) {
		t.Fatalf("restored purposes = %+v", links)
	}
}

func TestCockpitMeetingProvisionConcurrentRetriesReuseIssue(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Concurrent meeting work", true)
	meeting := createMeeting(t, f.wsID, map[string]any{"title": "Prepare minutes"})
	type response struct {
		status int
		body   []byte
	}
	responses := make(chan response, 4)
	for range 4 {
		req := testutil.WithURLParams(cockpitRequest(http.MethodPost,
			"/api/cockpit/meetings/"+meeting.ID+"/provision", f.wsID, map[string]any{
				"create_task": true, "create_dir": false, "remember": false,
				"project_id": f.project, "module_id": f.module, "node_id": f.node,
			}), "meetingId", meeting.ID)
		go func() {
			recorder := httptest.NewRecorder()
			cockpitHandler(testHandler.ProvisionCockpitMeeting).ServeHTTP(recorder, req)
			responses <- response{recorder.Code, recorder.Body.Bytes()}
		}()
	}
	var id string
	for range 4 {
		res := <-responses
		var out CockpitMeetingProvisionResponse
		if res.status != http.StatusOK || json.Unmarshal(res.body, &out) != nil || out.TaskError != "" || out.Task == nil {
			t.Fatalf("provision failed: %d %s", res.status, res.body)
		}
		if id != "" && out.Task.IssueID != id {
			t.Fatalf("concurrent retry created different tasks: %s and %s", id, out.Task.IssueID)
		}
		id = out.Task.IssueID
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id = $1", f.wsID); n != 1 {
		t.Fatalf("provision created %d issues, want exactly one", n)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM cockpit_node_issue WHERE issue_id = $1 AND node_id = $2", id, f.node); n != 1 {
		t.Fatalf("archive link count = %d, want one", n)
	}
	setMeetingRoles(t, f.wsID, meeting.ID, id, map[string]any{"roles": []string{"minutes", "review"}}).Want(http.StatusOK)
	retried := f.provision(t, meeting.ID, map[string]any{
		"create_task": true, "create_dir": false, "remember": false,
		"project_id": f.project, "module_id": f.module, "node_id": f.node,
	})
	if retried.Task == nil || retried.Task.IssueID != id || !reflect.DeepEqual(retried.Task.Roles, []string{"minutes", "review"}) {
		t.Fatalf("retry did not preserve the task and its purposes: %+v", retried)
	}
}
