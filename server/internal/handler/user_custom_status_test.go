package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// newStatusTestUser mirrors newTimezoneTestUser: the /api/me family tests
// create their user inline because the fixture builders start at workspace
// level and this row needs no workspace at all.
func newStatusTestUser(t *testing.T, email string) string {
	t.Helper()
	ctx := context.Background()

	var userID string
	if err := testPool.QueryRow(ctx,
		`INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id`,
		"Status Test", email,
	).Scan(&userID); err != nil {
		t.Fatalf("insert test user: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM "user" WHERE id = $1`, userID)
	})
	return userID
}

func TestUpdateMeAcceptsCustomStatus(t *testing.T) {
	userID := newStatusTestUser(t, "status-set@multica.ai")

	w := httptest.NewRecorder()
	req := newPatchMeRequest(userID, `{"custom_status":"☕ coffee time"}`)
	testHandler.UpdateMe(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var stored string
	if err := testPool.QueryRow(context.Background(),
		`SELECT custom_status FROM "user" WHERE id = $1`, userID,
	).Scan(&stored); err != nil {
		t.Fatalf("lookup user: %v", err)
	}
	if stored != "☕ coffee time" {
		t.Fatalf("expected custom_status to persist, got %q", stored)
	}

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got, _ := resp["custom_status"].(string); got != "☕ coffee time" {
		t.Fatalf("expected response custom_status to round-trip, got %v", resp["custom_status"])
	}
}

func TestUpdateMeRejectsOverlongCustomStatus(t *testing.T) {
	userID := newStatusTestUser(t, "status-reject@multica.ai")
	body := `{"custom_status":"` + strings.Repeat("好", MaxCustomStatusLen+1) + `"}`

	w := httptest.NewRecorder()
	req := newPatchMeRequest(userID, body)
	testHandler.UpdateMe(w, req)

	if w.Code != 400 {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}

	var stored string
	if err := testPool.QueryRow(context.Background(),
		`SELECT custom_status FROM "user" WHERE id = $1`, userID,
	).Scan(&stored); err != nil {
		t.Fatalf("lookup user: %v", err)
	}
	if stored != "" {
		t.Fatalf("expected custom_status unchanged (empty), got %q", stored)
	}
}

// COALESCE semantics — omitting custom_status must NOT clear an existing
// value; only an explicit "" clears it (NOT NULL column, no NULL semantics).
func TestUpdateMePreservesAndClearsCustomStatus(t *testing.T) {
	userID := newStatusTestUser(t, "status-clear@multica.ai")

	if _, err := testPool.Exec(context.Background(),
		`UPDATE "user" SET custom_status = 'gym session' WHERE id = $1`, userID,
	); err != nil {
		t.Fatalf("preset custom_status: %v", err)
	}

	w := httptest.NewRecorder()
	req := newPatchMeRequest(userID, `{"name":"Still Named"}`)
	testHandler.UpdateMe(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var stored string
	if err := testPool.QueryRow(context.Background(),
		`SELECT custom_status FROM "user" WHERE id = $1`, userID,
	).Scan(&stored); err != nil {
		t.Fatalf("lookup user: %v", err)
	}
	if stored != "gym session" {
		t.Fatalf("expected custom_status preserved, got %q", stored)
	}

	w = httptest.NewRecorder()
	req = newPatchMeRequest(userID, `{"custom_status":""}`)
	testHandler.UpdateMe(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	if err := testPool.QueryRow(context.Background(),
		`SELECT custom_status FROM "user" WHERE id = $1`, userID,
	).Scan(&stored); err != nil {
		t.Fatalf("lookup user: %v", err)
	}
	if stored != "" {
		t.Fatalf("expected custom_status cleared, got %q", stored)
	}
}

// The office reads everyone's status through the members list, so the column
// must ride along there too — not only on /api/me.
func TestListMembersWithUserCarriesCustomStatus(t *testing.T) {
	fx := testutil.New(testPool, "", "")
	userID := fx.User(t, "Status Member", "status-list@multica.ai", testutil.Cols{
		"custom_status": "🏋️ at the gym",
	})
	wsID := fx.Workspace(t, "Status WS", "status-ws")
	fx.Member(t, wsID, userID, "member")

	var list []map[string]any
	req := testutil.WithURLParams(
		httptest.NewRequest(http.MethodGet, "/api/workspaces/"+wsID+"/members", nil),
		"id", wsID,
	)
	testutil.Call(t, testHandler.ListMembersWithUser, req).
		Want(http.StatusOK).JSON(&list)

	for _, m := range list {
		if m["user_id"] != userID {
			continue
		}
		if got, _ := m["custom_status"].(string); got != "🏋️ at the gym" {
			t.Fatalf("expected custom_status to ride along, got %q", got)
		}
		return
	}
	t.Fatalf("member %s missing from list of %d rows", userID, len(list))
}
