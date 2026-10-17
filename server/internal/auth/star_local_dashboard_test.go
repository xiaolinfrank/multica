package auth

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func starTestHandoff(now time.Time) map[string]any {
	return map[string]any{
		"ok": true, "httpUrl": "http://127.0.0.1:29989/", "wsUrl": "ws://127.0.0.1:29989",
		"browserUrl":                  "http://127.0.0.1:29989/#" + url.Values{"bootstrapToken": {strings.Repeat("a", 32)}, "bootstrapProfile": {"owner"}, "gatewayUrl": {"ws://127.0.0.1:29989"}}.Encode(),
		"browserBootstrapExpiresAtMs": now.Add(10 * time.Minute).UnixMilli(),
		"url":                         "http://127.0.0.1:29989/#token=DO-NOT-DELIVER-SHARED-TOKEN",
	}
}

func TestStarLocalDashboardHandoffValidation(t *testing.T) {
	now := time.Now()
	for _, mode := range []string{"ok", "legacy-only", "remote-origin", "foreign-gateway", "shared-token", "duplicate-token", "expired", "too-long", "failed"} {
		t.Run(mode, func(t *testing.T) {
			v := starTestHandoff(now)
			switch mode {
			case "legacy-only":
				delete(v, "browserUrl")
			case "remote-origin":
				v["browserUrl"] = strings.ReplaceAll(v["browserUrl"].(string), "127.0.0.1", "10.0.0.1")
			case "foreign-gateway":
				v["wsUrl"] = "ws://127.0.0.1:19889"
			case "shared-token":
				v["browserUrl"] = v["browserUrl"].(string) + "&token=shared"
			case "duplicate-token":
				v["browserUrl"] = v["browserUrl"].(string) + "&bootstrapToken=injected"
			case "expired":
				v["browserBootstrapExpiresAtMs"] = now.Add(-time.Second).UnixMilli()
			case "too-long":
				v["browserBootstrapExpiresAtMs"] = now.Add(time.Hour).UnixMilli()
			case "failed":
				v["ok"] = false
			}
			raw, _ := json.Marshal(v)
			got, err := validateStarBrowserHandoff(raw, "http://127.0.0.1:29989", now)
			if mode == "ok" {
				if err != nil || got != v["browserUrl"] || strings.Contains(got, "DO-NOT-DELIVER") {
					t.Fatal("native one-time handoff lost or shared credential leaked")
				}
			} else if err == nil {
				t.Fatal("unsafe native handoff accepted")
			}
		})
	}
}

func TestStarLocalDashboardOwnerCheckedBeforeNativeCommand(t *testing.T) {
	now := time.Now()
	calls := 0
	s := &StarOIDC{now: func() time.Time { return now }, users: map[string]string{"owner": "u1", "other": "u1"}}
	s.dashboard = &StarLocalDashboard{config: StarLocalDashboardConfig{OwnerSubject: "owner", Origin: "http://127.0.0.1:29989"}, run: func(context.Context) ([]byte, error) { calls++; return json.Marshal(starTestHandoff(now)) }}
	for _, identity := range []StarSignInResult{{UserID: "u1", Subject: "other", Destination: "openclaw"}, {UserID: "u2", Subject: "owner", Destination: "openclaw"}, {UserID: "u1", Subject: "owner"}} {
		if _, err := s.OpenLocalDashboard(context.Background(), identity); err != ErrStarDashboardOwner {
			t.Fatal("wrong owner/purpose accepted")
		}
	}
	if calls != 0 {
		t.Fatal("unauthorized account reached native bootstrap issuer")
	}
	if _, err := s.OpenLocalDashboard(context.Background(), StarSignInResult{UserID: "u1", Subject: "owner", Destination: "openclaw"}); err != nil || calls != 1 {
		t.Fatal("owner handoff failed")
	}
}

func TestStarLocalDashboardNativeUserOwnsLaunchWithoutOIDC(t *testing.T) {
	const owner = "11111111-1111-4111-8111-111111111111"
	d, err := newStarLocalDashboard(&StarLocalDashboardConfig{OwnerUserID: owner, Command: []string{"/test/fake-cli"}, StateDir: t.TempDir(), Origin: "http://127.0.0.1:29989"}, "http://127.0.0.1:13125", nil)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	d.run = func(context.Context) ([]byte, error) { calls++; return json.Marshal(starTestHandoff(time.Now())) }
	if _, err = d.OpenForUser(context.Background(), "22222222-2222-4222-8222-222222222222"); err != ErrStarDashboardOwner || calls != 0 {
		t.Fatal("foreign native user reached owner issuer")
	}
	if _, err = d.OpenForUser(context.Background(), owner); err != nil || calls != 1 {
		t.Fatal("native owner handoff failed", err)
	}
}

func TestSingleOwnerDashboardRequiresExplicitConfigAndProcessMode(t *testing.T) {
	const owner = "11111111-1111-4111-8111-111111111111"
	const other = "22222222-2222-4222-8222-222222222222"
	cfg := StarLocalDashboardConfig{SingleOwner: true, Command: []string{"/test/fake-cli"}, StateDir: t.TempDir(), Origin: "http://127.0.0.1:29989"}
	path := filepath.Join(t.TempDir(), "dashboard.json")
	writeConfig := func() {
		t.Helper()
		raw, err := json.Marshal(cfg)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	writeConfig()
	t.Setenv("MULTICA_SINGLE_OWNER", "false")
	if _, err := LoadSingleOwnerLocalDashboard(path, "http://localhost:13125"); err == nil {
		t.Fatal("single-owner loader accepted disabled process mode")
	}
	t.Setenv("MULTICA_SINGLE_OWNER", "true")
	if _, err := LoadStarLocalDashboard(path, "http://localhost:13125"); err == nil {
		t.Fatal("multi-user loader accepted an unbound single-owner config")
	}
	if _, err := newStarLocalDashboard(&cfg, "http://localhost:13125/auth/star/callback", map[string]string{"owner": owner}); err == nil {
		t.Fatal("OIDC launcher accepted single-owner config")
	}
	d, err := LoadSingleOwnerLocalDashboard(path, "http://localhost:13125")
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	d.run = func(context.Context) ([]byte, error) { calls++; return json.Marshal(starTestHandoff(time.Now())) }
	if _, err := d.OpenForUser(context.Background(), owner); err != ErrStarDashboardOwner {
		t.Fatal("generic path accepted an unbound launcher")
	}
	for _, ids := range [][2]string{{owner, ""}, {owner, "invalid"}, {other, owner}} {
		if _, err := d.OpenForSingleOwner(context.Background(), ids[0], ids[1]); err != ErrStarDashboardOwner {
			t.Fatal("missing or foreign native singleton accepted")
		}
	}
	if calls != 0 {
		t.Fatal("denied launch reached the CLI")
	}
	if _, err := d.OpenForSingleOwner(context.Background(), owner, owner); err != nil || calls != 1 || d.config.OwnerUserID != "" {
		t.Fatal("first owner could not launch without changing shared config", err)
	}
	t.Setenv("MULTICA_SINGLE_OWNER", "false")
	if _, err := d.OpenForSingleOwner(context.Background(), owner, owner); err != ErrStarDashboardOwner || calls != 1 {
		t.Fatal("launch remained enabled after leaving single-owner mode")
	}
	t.Setenv("MULTICA_SINGLE_OWNER", "true")
	cfg.SingleOwner = false
	writeConfig()
	if _, err := LoadStarLocalDashboard(path, "http://localhost:13125"); err == nil {
		t.Fatal("multi-user loader accepted empty owner without a single-owner flag")
	}
	if _, err := LoadSingleOwnerLocalDashboard(path, "http://localhost:13125"); err == nil {
		t.Fatal("missing explicit single-owner flag accepted with no owner")
	}
	cfg.SingleOwner, cfg.OwnerUserID = true, other
	writeConfig()
	d, err = LoadSingleOwnerLocalDashboard(path, "http://localhost:13125")
	if err != nil {
		t.Fatal(err)
	}
	d.run = func(context.Context) ([]byte, error) {
		t.Fatal("mismatched configured owner reached CLI")
		return nil, nil
	}
	if _, err := d.OpenForSingleOwner(context.Background(), owner, owner); err != ErrStarDashboardOwner {
		t.Fatal("explicit configured owner was ignored")
	}
}

func TestStarLocalRequestRefusesForeignHost(t *testing.T) {
	for _, host := range []string{"attacker.example", "127.0.0.1.attacker.example", "10.0.0.1:13125", "localhost@attacker.example", "localhost/path", ""} {
		r := httptest.NewRequest("POST", "http://localhost/api/local-dashboard", nil)
		r.RemoteAddr, r.Host = "127.0.0.1:1234", host
		if IsStarLocalRequest(r) {
			t.Fatal("foreign or malformed HTTP host accepted", host)
		}
	}
}

func TestStarLocalRequestRefusesRemoteAndForwardedClients(t *testing.T) {
	for _, tc := range []struct {
		peer, forwarded string
		want            bool
	}{{"127.0.0.1:1234", "", true}, {"[::1]:1234", "127.0.0.1, ::1", true}, {"10.0.0.1:1234", "127.0.0.1", false}, {"127.0.0.1:1234", "10.0.0.1", false}, {"127.0.0.1:1234", "spoofed", false}} {
		r := httptest.NewRequest("GET", "http://localhost/auth/star/start", nil)
		r.RemoteAddr = tc.peer
		if tc.forwarded != "" {
			r.Header.Set("X-Forwarded-For", tc.forwarded)
		}
		if IsStarLocalRequest(r) != tc.want {
			t.Fatal("local boundary mismatch", tc.peer, tc.forwarded)
		}
	}
}

func TestStarLocalDashboardUsesOnlyOwnedFakeCLIAndCleanEnvironment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	dir := t.TempDir()
	executable := filepath.Join(dir, "openclaw-fixture")
	raw, _ := json.Marshal(starTestHandoff(time.Now()))
	script := "#!/bin/sh\n[ \"$*\" = 'dashboard --json' ] || exit 1\n[ -z \"$DATABASE_URL$OPENCLAW_GATEWAY_TOKEN\" ] || exit 2\n[ \"$OPENCLAW_CONFIG_PATH\" = \"$OPENCLAW_STATE_DIR/openclaw.json\" ] || exit 3\nprintf '%s' '" + string(raw) + "'\n"
	if err := os.WriteFile(executable, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DATABASE_URL", "sensitive-database")
	t.Setenv("OPENCLAW_GATEWAY_TOKEN", "foreign-gateway")
	d, err := newStarLocalDashboard(&StarLocalDashboardConfig{OwnerSubject: "owner", Command: []string{executable}, StateDir: dir, Origin: "http://127.0.0.1:29989"}, "http://localhost:13124/auth/star/callback", map[string]string{"owner": "u1"})
	if err != nil {
		t.Fatal(err)
	}
	output, err := d.run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = validateStarBrowserHandoff(output, d.config.Origin, time.Now()); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []StarLocalDashboardConfig{{OwnerSubject: "missing", Command: []string{executable}, StateDir: dir, Origin: d.config.Origin}, {OwnerSubject: "owner", Command: []string{"openclaw"}, StateDir: dir, Origin: d.config.Origin}, {OwnerSubject: "owner", Command: []string{executable}, StateDir: dir, Origin: "http://10.0.0.1:29989"}} {
		if _, err := newStarLocalDashboard(&bad, "http://localhost:13124/auth/star/callback", map[string]string{"owner": "u1"}); err == nil {
			t.Fatal("unsafe local launch configuration accepted")
		}
	}
}
