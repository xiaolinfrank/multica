package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// watched_by_user_id is the Agent Office's "is this human actually working"
// signal: an issue's assignee is often an agent while the human still works
// alongside it, so participation is read from issue_subscriber rows.
func TestListIssuesWatchedByUserFilter(t *testing.T) {
	watcherID := dbfx.User(t, "Office Watcher", "office-watcher@multica.ai")
	otherID := dbfx.User(t, "Office Bystander", "office-bystander@multica.ai")

	subscribed := dbfx.Issue(t, "watched-subscribed", testutil.Cols{"status": "in_progress"})
	unwatched := dbfx.Issue(t, "watched-unwatched", testutil.Cols{"status": "in_progress"})

	subscribe := func(issueID, userID string) {
		dbfx.InsertNoID(t, "issue_subscriber", testutil.Cols{
			"issue_id":  issueID,
			"user_type": "member",
			"user_id":   userID,
			"reason":    "manual",
		}, "issue_id = $1 AND user_id = $2", issueID, userID)
	}
	subscribe(subscribed, watcherID)
	// A different member's subscription must not leak through the filter.
	subscribe(unwatched, otherID)

	listWatched := func() map[string]bool {
		path := fmt.Sprintf("/api/issues?workspace_id=%s&watched_by_user_id=%s&limit=500",
			testWorkspaceID, watcherID)
		w := httptest.NewRecorder()
		testHandler.ListIssues(w, newRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("ListIssues: expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var resp struct {
			Issues []IssueResponse `json:"issues"`
		}
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode list response: %v", err)
		}
		ids := make(map[string]bool, len(resp.Issues))
		for _, iss := range resp.Issues {
			ids[iss.ID] = true
		}
		return ids
	}

	ids := listWatched()
	if !ids[subscribed] {
		t.Fatalf("watched filter missing the subscribed issue %s", subscribed)
	}
	if ids[unwatched] {
		t.Fatalf("watched filter leaked another member's subscription (%s)", unwatched)
	}

	// A revoked (unsubscribed_at) row no longer counts as watching.
	if _, err := testPool.Exec(context.Background(),
		`UPDATE issue_subscriber SET unsubscribed_at = now() WHERE issue_id = $1 AND user_id = $2`,
		subscribed, watcherID); err != nil {
		t.Fatalf("revoke subscription: %v", err)
	}
	if ids = listWatched(); ids[subscribed] {
		t.Fatalf("revoked subscription still matched the watched filter")
	}

	// Malformed UUIDs are a client bug — reject, don't coerce.
	testutil.Call(t, testHandler.ListIssues, newRequest(http.MethodGet,
		fmt.Sprintf("/api/issues?workspace_id=%s&watched_by_user_id=not-a-uuid", testWorkspaceID), nil)).
		Want(http.StatusBadRequest)
}
