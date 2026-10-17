package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
)

// StarLocalDashboardConfig is an owner-only local launcher configuration. The
// native CLI owns bootstrap issuance, device pairing, scopes and revocation.
// Command is an absolute CLI path, or [absolute node path, absolute CLI script].
type StarLocalDashboardConfig struct {
	OwnerSubject string   `json:"ownerSubject"`
	OwnerUserID  string   `json:"ownerUserId,omitempty"`
	Command      []string `json:"command"`
	StateDir     string   `json:"stateDir"`
	Origin       string   `json:"origin"`
}

type StarLocalDashboard struct {
	config StarLocalDashboardConfig
	run    func(context.Context) ([]byte, error)
}

var ErrStarDashboardOwner = errors.New("star account is not the configured local dashboard owner")
var errStarDashboard = errors.New("local dashboard is unavailable")

func isStarLoopbackHost(host string) bool {
	return host == "localhost" || net.ParseIP(host).IsLoopback()
}

func newStarLocalDashboard(cfg *StarLocalDashboardConfig, callback string, users map[string]string) (*StarLocalDashboard, error) {
	if cfg == nil {
		return nil, nil
	}
	origin, err := starURL(cfg.Origin, true)
	if err != nil || !isStarLoopbackHost(origin.Hostname()) || (origin.Path != "" && origin.Path != "/") {
		return nil, errStarDashboard
	}
	cb, err := starURL(callback, true)
	ownerValid := users != nil && cfg.OwnerUserID == "" && users[cfg.OwnerSubject] != ""
	if users == nil {
		ownerValid = cfg.OwnerSubject == "" && uuid.Validate(cfg.OwnerUserID) == nil
	}
	if err != nil || !isStarLoopbackHost(cb.Hostname()) || !ownerValid || !filepath.IsAbs(cfg.StateDir) || len(cfg.Command) < 1 || len(cfg.Command) > 2 {
		return nil, errStarDashboard
	}
	for _, arg := range cfg.Command {
		if !filepath.IsAbs(arg) {
			return nil, errStarDashboard
		}
	}
	c := *cfg
	c.Command = append([]string(nil), cfg.Command...)
	c.Origin = strings.TrimRight(c.Origin, "/")
	d := &StarLocalDashboard{config: c}
	d.run = d.runNativeCLI
	return d, nil
}

// LoadStarLocalDashboard binds the native Multica user to the local owner
// launcher. It uses no external identity provider or second account database.
func LoadStarLocalDashboard(path, appURL string) (*StarLocalDashboard, error) {
	info, err := os.Lstat(path)
	if !filepath.IsAbs(path) || err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 65536 {
		return nil, errStarDashboard
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, errStarDashboard
	}
	var cfg StarLocalDashboardConfig
	if json.Unmarshal(raw, &cfg) != nil {
		return nil, errStarDashboard
	}
	return newStarLocalDashboard(&cfg, appURL, nil)
}

func (d *StarLocalDashboard) OpenForUser(ctx context.Context, userID string) (string, error) {
	if d.config.OwnerUserID == "" || userID != d.config.OwnerUserID {
		return "", ErrStarDashboardOwner
	}
	raw, err := d.run(ctx)
	if err != nil {
		return "", errStarDashboard
	}
	return validateStarBrowserHandoff(raw, d.config.Origin, time.Now())
}

// IsStarLocalRequest never uses a forwarded header to grant local access.
// A nonlocal peer or any explicitly forwarded nonlocal client is refused.
func IsStarLocalRequest(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || !net.ParseIP(host).IsLoopback() || r.Header.Get("Forwarded") != "" {
		return false
	}
	for _, header := range []string{"X-Forwarded-For", "X-Real-IP"} {
		for _, value := range r.Header.Values(header) {
			for _, ip := range strings.Split(value, ",") {
				if !net.ParseIP(strings.TrimSpace(ip)).IsLoopback() {
					return false
				}
			}
		}
	}
	return true
}

type starBoundedOutput struct{ bytes.Buffer }

func (b *starBoundedOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 64*1024 {
		return 0, io.ErrShortBuffer
	}
	return b.Buffer.Write(p)
}

func (d *StarLocalDashboard) runNativeCLI(ctx context.Context) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	args := append(append([]string(nil), d.config.Command[1:]...), "dashboard", "--json")
	cmd := exec.CommandContext(ctx, d.config.Command[0], args...)
	cmd.Dir = d.config.StateDir
	// Do not pass BayClaw database credentials, provider tokens, proxy variables,
	// or another Gateway's auth environment into this independent native profile.
	for _, key := range []string{"HOME", "USER", "PATH", "TMPDIR"} {
		if value, ok := os.LookupEnv(key); ok {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	cmd.Env = append(cmd.Env, "OPENCLAW_STATE_DIR="+d.config.StateDir, "OPENCLAW_CONFIG_PATH="+filepath.Join(d.config.StateDir, "openclaw.json"))
	cmd.WaitDelay = time.Second
	var stdout starBoundedOutput
	cmd.Stdout = &stdout
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return nil, errStarDashboard
	}
	return stdout.Bytes(), nil
}

func (s *StarOIDC) OpenLocalDashboard(ctx context.Context, identity StarSignInResult) (string, error) {
	if s.dashboard == nil {
		return "", errStarDashboard
	}
	if identity.Destination != "openclaw" || identity.Subject != s.dashboard.config.OwnerSubject || identity.UserID == "" || s.users[identity.Subject] != identity.UserID {
		return "", ErrStarDashboardOwner
	}
	raw, err := s.dashboard.run(ctx)
	if err != nil {
		return "", errStarDashboard
	}
	return validateStarBrowserHandoff(raw, s.dashboard.config.Origin, s.now())
}

// Never fall back to the legacy `url` field, which can contain a shared token.
func validateStarBrowserHandoff(raw []byte, origin string, now time.Time) (string, error) {
	var result struct {
		OK        bool   `json:"ok"`
		Browser   string `json:"browserUrl"`
		HTTP      string `json:"httpUrl"`
		WS        string `json:"wsUrl"`
		ExpiresMS int64  `json:"browserBootstrapExpiresAtMs"`
	}
	if len(raw) > 64*1024 || json.Unmarshal(raw, &result) != nil || !result.OK || result.ExpiresMS <= now.UnixMilli() || result.ExpiresMS > now.Add(11*time.Minute).UnixMilli() {
		return "", errStarDashboard
	}
	base, err := starURL(origin, true)
	if err != nil || !isStarLoopbackHost(base.Hostname()) || strings.TrimRight(result.HTTP, "/") != origin {
		return "", errStarDashboard
	}
	ws := strings.Replace(origin, "http", "ws", 1)
	if strings.TrimRight(result.WS, "/") != ws {
		return "", errStarDashboard
	}
	u, err := url.Parse(result.Browser)
	if err != nil || u.Scheme != base.Scheme || u.Host != base.Host || u.User != nil || u.RawQuery != "" || (u.Path != "" && u.Path != "/") {
		return "", errStarDashboard
	}
	fragment, err := url.ParseQuery(u.Fragment)
	if err != nil || len(fragment.Get("bootstrapToken")) < 24 || fragment.Get("gatewayUrl") != result.WS || fragment.Get("bootstrapProfile") != "owner" {
		return "", errStarDashboard
	}
	for key, values := range fragment {
		if len(values) != 1 || (key != "bootstrapToken" && key != "bootstrapProfile" && key != "gatewayUrl") {
			return "", errStarDashboard
		}
	}
	return result.Browser, nil
}
