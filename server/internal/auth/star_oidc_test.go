package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestStarOIDCCodeFlow(t *testing.T) {
	for _, mode := range []string{"ok", "issuer", "audience", "expired", "nonce", "signature", "missing-id-token", "unlinked", "pkce", "state", "cookie", "flow-expired", "duplicate-code", "replay"} {
		t.Run(mode, func(t *testing.T) {
			key, err := rsa.GenerateKey(rand.Reader, 2048)
			if err != nil {
				t.Fatal(err)
			}
			var server *httptest.Server
			nonce, challenge := "", ""
			used := false
			exchanges := 0
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/.well-known/openid-configuration":
					json.NewEncoder(w).Encode(map[string]any{"issuer": server.URL, "authorization_endpoint": server.URL + "/authorize", "token_endpoint": server.URL + "/token", "jwks_uri": server.URL + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"}})
				case "/keys":
					json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]any{"kty": "RSA", "kid": "test", "use": "sig", "alg": "RS256", "n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes())}}})
				case "/token":
					exchanges++
					r.ParseForm()
					sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
					if used || r.Form.Get("code") != "single-use-code" || base64.RawURLEncoding.EncodeToString(sum[:]) != challenge {
						w.WriteHeader(400)
						w.Write([]byte(`{"error":"invalid_grant"}`))
						return
					}
					used = true
					claims := jwt.MapClaims{"iss": server.URL, "sub": "star-subject", "aud": "bayclaw", "exp": time.Now().Add(time.Minute).Unix(), "iat": time.Now().Unix(), "nonce": nonce}
					switch mode {
					case "issuer":
						claims["iss"] = "https://other.example"
					case "audience":
						claims["aud"] = "other-client"
					case "expired":
						claims["exp"] = time.Now().Add(-time.Hour).Unix()
					case "nonce":
						claims["nonce"] = "other-flow"
					case "unlinked":
						claims["sub"] = "other-user"
					}
					token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
					token.Header["kid"] = "test"
					signed, _ := token.SignedString(key)
					if mode == "signature" {
						parts := strings.Split(signed, ".")
						parts[2] = base64.RawURLEncoding.EncodeToString(make([]byte, 256))
						signed = strings.Join(parts, ".")
					}
					if mode == "missing-id-token" {
						signed = ""
					}
					json.NewEncoder(w).Encode(map[string]any{"access_token": "synthetic-access", "token_type": "Bearer", "id_token": signed, "expires_in": 60})
				default:
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			s, err := NewStarOIDC(context.Background(), StarOIDCConfig{Issuer: server.URL, ClientID: "bayclaw", ClientSecret: "test-secret", RedirectURI: "http://127.0.0.1:13000/auth/star/callback", CookieKey: base64.StdEncoding.EncodeToString(make([]byte, 32)), Subjects: map[string]string{"star-subject": "11111111-1111-4111-8111-111111111111"}, AllowLoopbackHTTP: true})
			if err != nil {
				t.Fatal(err)
			}
			next := "/login?cli_callback=http%3A%2F%2F127.0.0.1%3A4567%2Fcallback&cli_state=original"
			target, cookie, err := s.Begin(next)
			if err != nil {
				t.Fatal(err)
			}
			u, _ := url.Parse(target)
			q := u.Query()
			nonce = q.Get("nonce")
			challenge = q.Get("code_challenge")
			if q.Get("code_challenge_method") != "S256" || nonce == "" || q.Get("state") == "" || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode {
				t.Fatal("missing native OAuth protections")
			}
			callback := url.Values{"state": {q.Get("state")}, "code": {"single-use-code"}}
			switch mode {
			case "state":
				callback.Set("state", "forged")
			case "cookie":
				cookie.Value = "tampered"
			case "pkce":
				challenge = "wrong"
			case "duplicate-code":
				callback.Add("code", "injected")
			case "flow-expired":
				s.now = func() time.Time { return time.Now().Add(6 * time.Minute) }
			}
			req := httptest.NewRequest("GET", "http://127.0.0.1:13000/auth/star/callback?"+callback.Encode(), nil)
			req.AddCookie(cookie)
			id, path, err := s.Finish(context.Background(), req)
			if mode == "ok" || mode == "replay" {
				if err != nil || id != "11111111-1111-4111-8111-111111111111" || path != next {
					t.Fatalf("sign-in failed: %v", err)
				}
			} else if err == nil {
				t.Fatal("invalid sign-in accepted")
			}
			if mode == "replay" {
				if _, _, err = s.Finish(context.Background(), req); err == nil {
					t.Fatal("authorization code replay accepted")
				}
			}
			if (mode == "state" || mode == "cookie" || mode == "duplicate-code" || mode == "flow-expired") && exchanges != 0 {
				t.Fatal("invalid browser state reached token exchange")
			}
			if s.ClearCookie().MaxAge != -1 {
				t.Fatal("flow cookie not cleared")
			}
		})
	}
}

func TestStarOIDCRejectsUnsafeConfigurationAndRedirects(t *testing.T) {
	for _, raw := range []string{"http://issuer.example", "https://user:pass@issuer.example", "javascript:bad", "https://issuer.example?key=bad"} {
		if _, err := starURL(raw, false); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	for _, next := range []string{"https://evil.example", "//evil.example", "/\\evil.example", "/%2f/evil.example", "/%5cevil.example", "/auth/star/start"} {
		if starNext(next) != "/login" {
			t.Errorf("unsafe next %s", next)
		}
	}
	if starNext("/demo/projects") != "/demo/projects" {
		t.Fatal("safe relative next lost")
	}
	if _, err := NewStarOIDC(context.Background(), StarOIDCConfig{Issuer: "https://issuer.example", ClientID: "bayclaw", RedirectURI: "https://app.example/auth/star/callback", ClientSecret: "secret", CookieKey: strings.Repeat("a", 32), Subjects: map[string]string{"sub": "not-a-uuid"}}); err == nil {
		t.Fatal("bad binding accepted")
	}
}
