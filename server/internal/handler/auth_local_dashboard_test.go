package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/workspacecontext"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Setup requires an empty native user table. A private schema lets this test
// exercise that exact path without changing the suite's shared native fixture.
func freshLocalDashboardHandler(t *testing.T) (*Handler, *testutil.Fixture) {
	t.Helper()
	schema := "local_dashboard_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := testPool.Exec(t.Context(), "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = testPool.Exec(context.Background(), "DROP SCHEMA "+quoted+" CASCADE") })
	for _, table := range []string{"user", "workspace", "member", "issue_status", "single_owner_account", "personal_access_token", "task_token", "daemon_token"} {
		name := pgx.Identifier{table}.Sanitize()
		if _, err := testPool.Exec(t.Context(), "CREATE TABLE "+quoted+"."+name+" (LIKE "+name+" INCLUDING ALL)"); err != nil {
			t.Fatal(err)
		}
	}
	cfg := testPool.Config().Copy()
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	h := *testHandler
	h.DB, h.TxStarter, h.Queries = pool, pool, db.New(pool)
	h.cfg.AppURL = "http://127.0.0.1:23127"
	return &h, testutil.New(pool, "", "")
}

func TestLocalDashboardFirstSetupNeedsNoCLIPATAndRevokesRecoveredSession(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	t.Setenv("MULTICA_SINGLE_OWNER", "true")
	t.Setenv("MULTICA_ADOPT_OWNER_ID", "")
	t.Setenv("MULTICA_ADOPT_WORKSPACE_ID", "")
	h, fixture := freshLocalDashboardHandler(t)
	dir := t.TempDir()
	setupToken := strings.Repeat("b", 64)
	setupPath := filepath.Join(dir, "setup-token")
	if err := os.WriteFile(setupPath, []byte(setupToken), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MULTICA_SETUP_TOKEN_FILE", setupPath)
	origin := "http://127.0.0.1:29891"
	browser := origin + "/#" + url.Values{"bootstrapToken": {strings.Repeat("a", 32)}, "bootstrapProfile": {"owner"}, "gatewayUrl": {"ws://127.0.0.1:29891"}}.Encode()
	output, err := json.Marshal(map[string]any{"ok": true, "httpUrl": origin, "wsUrl": "ws://127.0.0.1:29891", "browserUrl": browser, "browserBootstrapExpiresAtMs": time.Now().Add(10 * time.Minute).UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	cli := filepath.Join(dir, "fake-openclaw")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\n[ \"$*\" = 'dashboard --json' ] || exit 1\nprintf '%s' '"+string(output)+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "dashboard.json")
	raw, err := json.Marshal(auth.StarLocalDashboardConfig{SingleOwner: true, Command: []string{cli}, StateDir: dir, Origin: origin})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	h.LocalDashboard, err = auth.LoadSingleOwnerLocalDashboard(configPath, h.cfg.AppURL)
	if err != nil {
		t.Fatal(err)
	}
	newLocalRequest := func(path string, body any) *http.Request {
		r := testutil.JSONRequest(http.MethodPost, h.cfg.AppURL+path, body)
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("Origin", h.cfg.AppURL)
		return r
	}
	setup := newLocalRequest("/auth/local/setup", map[string]string{"login_name": "owner", "display_name": "Local owner", "password": "test-owner-password-2026"})
	setup.Header.Set("X-Setup-Token", setupToken)
	var account struct {
		Token        string       `json:"token"`
		User         UserResponse `json:"user"`
		RecoveryCode string       `json:"recovery_code"`
	}
	created := testutil.Call(t, h.SetupLocalAccount, setup).Want(http.StatusOK).JSON(&account)
	if account.Token == "" || account.User.ID == "" || account.RecoveryCode == "" {
		t.Fatal("local setup did not issue the native owner session")
	}
	if got := fixture.Count(t, "SELECT count(*) FROM personal_access_token"); got != 0 {
		t.Fatal("local setup unexpectedly required or created a CLI PAT")
	}
	var workspaceContext string
	fixture.QueryRow(t, "SELECT context FROM workspace WHERE slug='personal'").Scan(&workspaceContext)
	if workspaceContext != workspacecontext.V1 {
		t.Fatal("new local owner workspace is missing the default collaboration context")
	}
	protected := middleware.Auth(h.Queries, nil, nil, nil, h.ValidateLocalSession)(RequireHumanActor(http.HandlerFunc(h.OpenLocalDashboard)))
	requestWithToken := func(token string) *http.Request {
		r := newLocalRequest("/api/local-dashboard", nil)
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		return r
	}
	var handoff struct {
		BrowserURL string `json:"browser_url"`
	}
	testutil.Call(t, protected.ServeHTTP, requestWithToken(account.Token)).Want(http.StatusOK).JSON(&handoff)
	if handoff.BrowserURL != browser {
		t.Fatal("first native owner session lost its one-time dashboard handoff")
	}
	testutil.Call(t, protected.ServeHTTP, requestWithToken("")).Want(http.StatusUnauthorized)
	for _, mode := range []string{"foreign-host", "foreign-origin", "remote-peer"} {
		r := requestWithToken(account.Token)
		switch mode {
		case "foreign-host":
			r.Host = "attacker.example"
		case "foreign-origin":
			r.Header.Set("Origin", "https://attacker.example")
		case "remote-peer":
			r.RemoteAddr = "10.0.0.1:1234"
		}
		testutil.Call(t, protected.ServeHTTP, r).Want(http.StatusForbidden)
	}
	cookieRequest := newLocalRequest("/api/local-dashboard", nil)
	for _, cookie := range created.Result().Cookies() {
		cookieRequest.AddCookie(cookie)
	}
	testutil.Call(t, protected.ServeHTTP, cookieRequest).Want(http.StatusForbidden)
	for _, cookie := range created.Result().Cookies() {
		if cookie.Name == auth.SessionCSRFCookieName {
			cookieRequest.Header.Set(auth.CSRFHeaderName, cookie.Value)
		}
	}
	testutil.Call(t, protected.ServeHTTP, cookieRequest).Want(http.StatusOK)
	otherID := fixture.User(t, "Other", "other@dashboard.example")
	wrongOwner := newLocalRequest("/api/local-dashboard", nil)
	wrongOwner.Header.Set("X-User-ID", otherID)
	testutil.Call(t, h.OpenLocalDashboard, wrongOwner).Want(http.StatusForbidden)
	// Resolve the singleton on every request rather than caching the first owner
	// into shared launcher configuration.
	fixture.Exec(t, "UPDATE single_owner_account SET user_id=$1 WHERE singleton=1", parseUUID(otherID))
	oldOwner := newLocalRequest("/api/local-dashboard", nil)
	oldOwner.Header.Set("X-User-ID", account.User.ID)
	testutil.Call(t, h.OpenLocalDashboard, oldOwner).Want(http.StatusForbidden)
	fixture.Exec(t, "UPDATE single_owner_account SET user_id=$1 WHERE singleton=1", parseUUID(account.User.ID))
	recoverRequest := newLocalRequest("/auth/local/recover", map[string]string{"recovery_code": account.RecoveryCode, "password": "recovered-owner-password-2026"})
	var recovered struct {
		Token string `json:"token"`
	}
	testutil.Call(t, h.RecoverLocalAccount, recoverRequest).Want(http.StatusOK).JSON(&recovered)
	testutil.Call(t, protected.ServeHTTP, requestWithToken(account.Token)).Want(http.StatusUnauthorized)
	testutil.Call(t, protected.ServeHTTP, requestWithToken(recovered.Token)).Want(http.StatusOK)
	if got := fixture.Count(t, "SELECT count(*) FROM personal_access_token"); got != 0 {
		t.Fatalf("dashboard bootstrap changed the independent CLI credential lifecycle: %d tokens", got)
	}
}
