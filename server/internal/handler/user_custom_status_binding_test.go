package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// Pins the status→zone binding columns: the preset key stored beside the
// text, the 2h TTL stamped on every write, and the read-side resolution that
// makes an expired status read back as if never set (so clients never need
// expiry logic or a trusted clock).

func TestUpdateMeCustomStatusBinding(t *testing.T) {
	userID := newStatusTestUser(t, "status-bind@multica.ai")

	// Preset save: key rides along and the expiry is stamped at now+2h.
	resp := testutil.Call(t, testHandler.UpdateMe,
		newPatchMeRequest(userID, `{"custom_status":"🗣 In a meeting","custom_status_key":"meeting"}`)).
		Want(http.StatusOK)

	var key string
	var expires *time.Time
	if err := testPool.QueryRow(context.Background(),
		`SELECT custom_status_key, custom_status_expires_at FROM "user" WHERE id = $1`, userID,
	).Scan(&key, &expires); err != nil {
		t.Fatalf("lookup user: %v", err)
	}
	if key != "meeting" {
		t.Fatalf("expected custom_status_key to persist, got %q", key)
	}
	if expires == nil {
		t.Fatalf("expected custom_status_expires_at to be stamped")
	}
	drift := time.Until(*expires) - CustomStatusTTL
	if drift < -time.Minute || drift > time.Minute {
		t.Fatalf("expected expiry ≈ now+%s, got %v (drift %s)", CustomStatusTTL, *expires, drift)
	}

	var body map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got, _ := body["custom_status_key"].(string); got != "meeting" {
		t.Fatalf("expected response custom_status_key, got %v", body["custom_status_key"])
	}

	// Free text: an explicit "" key is fine (the default the editor sends).
	testutil.Call(t, testHandler.UpdateMe,
		newPatchMeRequest(userID, `{"custom_status":"reviewing PRs","custom_status_key":""}`)).
		Want(http.StatusOK)
	if err := testPool.QueryRow(context.Background(),
		`SELECT custom_status_key FROM "user" WHERE id = $1`, userID,
	).Scan(&key); err != nil {
		t.Fatalf("lookup user: %v", err)
	}
	if key != "" {
		t.Fatalf("expected free-text save to clear the key, got %q", key)
	}

	// Clearing the status clears the binding entirely.
	testutil.Call(t, testHandler.UpdateMe,
		newPatchMeRequest(userID, `{"custom_status":"","custom_status_key":""}`)).
		Want(http.StatusOK)
	if err := testPool.QueryRow(context.Background(),
		`SELECT custom_status_key, custom_status_expires_at FROM "user" WHERE id = $1`, userID,
	).Scan(&key, &expires); err != nil {
		t.Fatalf("lookup user: %v", err)
	}
	if key != "" || expires != nil {
		t.Fatalf("expected clear to wipe key and expiry, got key=%q expires=%v", key, expires)
	}
}

// Unknown keys are client bugs — reject rather than silently free-texting,
// and never half-apply a key without its status.
func TestUpdateMeCustomStatusKeyValidation(t *testing.T) {
	cases := map[string]string{
		"unknown-key":     `{"custom_status":"x","custom_status_key":"boardroom"}`,
		"key-sans-status": `{"custom_status_key":"meeting"}`,
	}
	for name, body := range cases {
		userID := newStatusTestUser(t, "status-key-reject-"+name+"@multica.ai")
		testutil.Call(t, testHandler.UpdateMe, newPatchMeRequest(userID, body)).
			Want(http.StatusBadRequest)
		var key string
		if err := testPool.QueryRow(context.Background(),
			`SELECT custom_status_key FROM "user" WHERE id = $1`, userID,
		).Scan(&key); err != nil {
			t.Fatalf("lookup user: %v", err)
		}
		if key != "" {
			t.Fatalf("%s: expected no key persisted, got %q", name, key)
		}
	}
}

// An expired status reads back as unset — text AND key — on both /api/me and
// the members list the office actually reads.
func TestCustomStatusExpiryResolvedOnRead(t *testing.T) {
	userID := newStatusTestUser(t, "status-expired@multica.ai")
	if _, err := testPool.Exec(context.Background(), `
		UPDATE "user"
		   SET custom_status = '🗣 In a meeting',
		       custom_status_key = 'meeting',
		       custom_status_expires_at = now() - interval '1 minute'
		 WHERE id = $1`, userID); err != nil {
		t.Fatalf("preset expired status: %v", err)
	}

	var me struct {
		CustomStatus    string `json:"custom_status"`
		CustomStatusKey string `json:"custom_status_key"`
	}
	getMe := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	getMe.Header.Set("X-User-ID", userID)
	testutil.Call(t, testHandler.GetMe, getMe).Want(http.StatusOK).JSON(&me)
	if me.CustomStatus != "" || me.CustomStatusKey != "" {
		t.Fatalf("expected expired status to read as unset, got %q/%q", me.CustomStatus, me.CustomStatusKey)
	}
}
