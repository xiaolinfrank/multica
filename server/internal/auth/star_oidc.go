package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
	"golang.org/x/oauth2"
)

// StarOIDC is an OIDC relying party, not an identity/token issuer. The provider
// owns accounts and SSO; Multica retains its existing user and workspace model.
// Subjects must be explicitly linked to existing users. Email and role claims
// never create an account, join a workspace, or grant a role.
type StarOIDC struct {
	oauth    oauth2.Config
	verifier *oidc.IDTokenVerifier
	box      *secretbox.Box
	users    map[string]string
	secure   bool
	client   *http.Client
	now      func() time.Time
}

type StarOIDCConfig struct {
	Issuer       string            `json:"issuer"`
	ClientID     string            `json:"clientId"`
	ClientSecret string            `json:"clientSecret"`
	RedirectURI  string            `json:"redirectUri"`
	CookieKey    string            `json:"cookieKey"`
	Subjects     map[string]string `json:"subjects"`
	// Explicit opt-in for an identity provider and callback confined to loopback.
	AllowLoopbackHTTP bool `json:"allowLoopbackHttp"`
}

const starCookie = "multica_star_login"
const starFlowTTL = 5 * time.Minute

var ErrStarLogin = errors.New("star sign-in could not be verified")
var ErrStarUnlinked = errors.New("star account is not linked to a Multica user")

type starFlow struct {
	State    string `json:"s"`
	Nonce    string `json:"n"`
	Verifier string `json:"v"`
	Next     string `json:"p"`
	Expires  int64  `json:"e"`
}

func starURL(raw string, allowLocal bool) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, ErrStarLogin
	}
	// RFC6761 reserves .localhost names for loopback; only the explicit lab flag permits HTTP.
	local := u.Hostname() == "localhost" || strings.HasSuffix(u.Hostname(), ".localhost") || net.ParseIP(u.Hostname()).IsLoopback()
	if u.Scheme != "https" && !(allowLocal && local && u.Scheme == "http") {
		return nil, ErrStarLogin
	}
	return u, nil
}

func NewStarOIDC(ctx context.Context, c StarOIDCConfig) (*StarOIDC, error) {
	if _, err := starURL(c.Issuer, c.AllowLoopbackHTTP); err != nil {
		return nil, err
	}
	redirect, err := starURL(c.RedirectURI, c.AllowLoopbackHTTP)
	if err != nil || redirect.Path != "/auth/star/callback" || strings.TrimSpace(c.ClientID) == "" || strings.TrimSpace(c.ClientSecret) == "" || len(c.Subjects) == 0 {
		return nil, ErrStarLogin
	}
	key, err := base64.StdEncoding.DecodeString(c.CookieKey)
	if err != nil {
		return nil, ErrStarLogin
	}
	box, err := secretbox.New(key)
	if err != nil {
		return nil, ErrStarLogin
	}
	users := make(map[string]string, len(c.Subjects))
	for subject, id := range c.Subjects {
		if strings.TrimSpace(subject) == "" || len(subject) > 512 || uuid.Validate(id) != nil {
			return nil, ErrStarLogin
		}
		users[subject] = id
	}
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	ctx = oidc.ClientContext(ctx, client)
	provider, err := oidc.NewProvider(ctx, c.Issuer)
	if err != nil {
		return nil, ErrStarLogin
	}
	endpoint := provider.Endpoint()
	var metadata struct {
		JWKSURL string `json:"jwks_uri"`
	}
	if err := provider.Claims(&metadata); err != nil {
		return nil, ErrStarLogin
	}
	for _, raw := range []string{endpoint.AuthURL, endpoint.TokenURL, metadata.JWKSURL} {
		if _, err := starURL(raw, c.AllowLoopbackHTTP); err != nil {
			return nil, err
		}
	}
	return &StarOIDC{oauth: oauth2.Config{ClientID: c.ClientID, ClientSecret: c.ClientSecret, RedirectURL: c.RedirectURI, Endpoint: endpoint, Scopes: []string{oidc.ScopeOpenID, "profile", "email"}}, verifier: provider.Verifier(&oidc.Config{ClientID: c.ClientID}), box: box, users: users, secure: redirect.Scheme == "https", client: client, now: time.Now}, nil
}

func starRandom() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// Only same-app paths survive login. In particular a CLI handoff returns to the
// existing /login page, which owns callback validation and explicit CLI consent.
func starNext(raw string) string {
	if raw == "" || len(raw) > 2048 {
		return "/login"
	}
	u, err := url.Parse(raw)
	if err != nil || u.IsAbs() || u.Host != "" || !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") || strings.HasPrefix(u.Path, "//") || strings.ContainsAny(u.Path, "\\\r\n") || strings.ContainsAny(raw, "\\\r\n") || strings.HasPrefix(u.Path, "/auth/") {
		return "/login"
	}
	return u.String()
}

func (s *StarOIDC) Begin(next string) (string, *http.Cookie, error) {
	state, err := starRandom()
	if err != nil {
		return "", nil, err
	}
	nonce, err := starRandom()
	if err != nil {
		return "", nil, err
	}
	flow := starFlow{State: state, Nonce: nonce, Verifier: oauth2.GenerateVerifier(), Next: starNext(next), Expires: s.now().Add(starFlowTTL).Unix()}
	raw, err := json.Marshal(flow)
	if err != nil {
		return "", nil, err
	}
	sealed, err := s.box.Seal(raw)
	if err != nil {
		return "", nil, err
	}
	cookie := s.cookie(base64.RawURLEncoding.EncodeToString(sealed), int(starFlowTTL.Seconds()))
	target := s.oauth.AuthCodeURL(state, oidc.Nonce(nonce), oauth2.S256ChallengeOption(flow.Verifier))
	return target, cookie, nil
}

func (s *StarOIDC) cookie(value string, maxAge int) *http.Cookie {
	return &http.Cookie{Name: starCookie, Value: value, Path: "/auth/star", HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteLaxMode, MaxAge: maxAge}
}
func (s *StarOIDC) ClearCookie() *http.Cookie { return s.cookie("", -1) }

func (s *StarOIDC) Finish(ctx context.Context, r *http.Request) (userID, next string, err error) {
	cookie, e := r.Cookie(starCookie)
	if e != nil || len(cookie.Value) > 8192 {
		return "", "", ErrStarLogin
	}
	sealed, e := base64.RawURLEncoding.DecodeString(cookie.Value)
	if e != nil {
		return "", "", ErrStarLogin
	}
	raw, e := s.box.Open(sealed)
	if e != nil {
		return "", "", ErrStarLogin
	}
	var flow starFlow
	if json.Unmarshal(raw, &flow) != nil || flow.Expires <= s.now().Unix() || flow.Expires > s.now().Add(starFlowTTL).Unix()+5 || flow.State == "" || flow.Nonce == "" || flow.Verifier == "" {
		return "", "", ErrStarLogin
	}
	q := r.URL.Query()
	if q.Get("error") != "" || q.Get("code") == "" || len(q["code"]) != 1 || len(q["state"]) != 1 || subtle.ConstantTimeCompare([]byte(flow.State), []byte(q.Get("state"))) != 1 {
		return "", "", ErrStarLogin
	}
	ctx = oidc.ClientContext(ctx, s.client)
	token, e := s.oauth.Exchange(ctx, q.Get("code"), oauth2.VerifierOption(flow.Verifier))
	if e != nil {
		return "", "", ErrStarLogin
	}
	idToken, ok := token.Extra("id_token").(string)
	if !ok {
		return "", "", ErrStarLogin
	}
	verified, e := s.verifier.Verify(ctx, idToken)
	if e != nil || subtle.ConstantTimeCompare([]byte(verified.Nonce), []byte(flow.Nonce)) != 1 {
		return "", "", ErrStarLogin
	}
	id, ok := s.users[verified.Subject]
	if !ok {
		return "", "", ErrStarUnlinked
	}
	return id, starNext(flow.Next), nil
}

// LoadStarOIDC uses an operator-owned private file, never request parameters.
func LoadStarOIDC(ctx context.Context, path, appURL string) (*StarOIDC, error) {
	if !filepath.IsAbs(path) {
		return nil, ErrStarLogin
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 65536 || info.Mode().Perm()&0077 != 0 {
		return nil, ErrStarLogin
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, ErrStarLogin
	}
	var cfg StarOIDCConfig
	if json.Unmarshal(raw, &cfg) != nil {
		return nil, ErrStarLogin
	}
	app, err := starURL(appURL, cfg.AllowLoopbackHTTP)
	if err != nil {
		return nil, err
	}
	callback, err := starURL(cfg.RedirectURI, cfg.AllowLoopbackHTTP)
	if err != nil || app.Scheme != callback.Scheme || app.Host != callback.Host {
		return nil, ErrStarLogin
	}
	return NewStarOIDC(ctx, cfg)
}
