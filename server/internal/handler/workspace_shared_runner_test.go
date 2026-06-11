package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestCreateWorkspace_AutoEnrollsSharedRunner guards the server-centric
// deployment contract: when SHARED_RUNNER_EMAILS is configured, every new
// workspace must automatically include the runner account as a member so
// the platform-operated daemon can serve it without a manual invitation.
// A configured email with no matching user must be skipped silently —
// workspace creation never depends on runner provisioning.
func TestCreateWorkspace_AutoEnrollsSharedRunner(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	const slug = "handler-tests-shared-runner"
	const runnerEmail = "shared-runner-fixture@test.local"

	var runnerID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO "user" (name, email) VALUES ('shared-runner-fixture', $1)
		ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
		RETURNING id
	`, runnerEmail).Scan(&runnerID); err != nil {
		t.Fatalf("create runner fixture: %v", err)
	}

	cleanup := func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM workspace WHERE slug = $1`, slug)
		_, _ = testPool.Exec(context.Background(), `DELETE FROM "user" WHERE email = $1`, runnerEmail)
	}
	cleanup()
	// The runner row was just deleted by cleanup; re-insert it.
	if err := testPool.QueryRow(ctx, `
		INSERT INTO "user" (name, email) VALUES ('shared-runner-fixture', $1) RETURNING id
	`, runnerEmail).Scan(&runnerID); err != nil {
		t.Fatalf("recreate runner fixture: %v", err)
	}
	t.Cleanup(cleanup)

	prev := testHandler.cfg
	testHandler.cfg = prev
	testHandler.cfg.SharedRunnerEmails = []string{
		runnerEmail,
		"missing-runner@test.local", // must be skipped, not fail the request
	}
	t.Cleanup(func() { testHandler.cfg = prev })

	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/workspaces", map[string]any{
		"name": "Shared Runner Probe",
		"slug": slug,
	})
	testHandler.CreateWorkspace(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateWorkspace: expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var role string
	err := testPool.QueryRow(ctx, `
		SELECT m.role FROM member m
		JOIN workspace ws ON ws.id = m.workspace_id
		WHERE ws.slug = $1 AND m.user_id = $2
	`, slug, runnerID).Scan(&role)
	if err != nil {
		t.Fatalf("runner was not auto-enrolled into the new workspace: %v", err)
	}
	if role != "member" {
		t.Fatalf("runner role = %q, want \"member\"", role)
	}

	// The creator must still be the owner — auto-enroll must not disturb it.
	var ownerCount int
	if err := testPool.QueryRow(ctx, `
		SELECT count(*) FROM member m
		JOIN workspace ws ON ws.id = m.workspace_id
		WHERE ws.slug = $1 AND m.user_id = $2 AND m.role = 'owner'
	`, slug, testUserID).Scan(&ownerCount); err != nil {
		t.Fatalf("count owner rows: %v", err)
	}
	if ownerCount != 1 {
		t.Fatalf("creator owner rows = %d, want 1", ownerCount)
	}
}
