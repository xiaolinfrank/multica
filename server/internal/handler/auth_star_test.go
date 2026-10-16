package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStarSignInUnavailableDoesNotIssueSession(t *testing.T) {
	h := &Handler{}
	for _, endpoint := range []string{"start", "callback"} {
		r := httptest.NewRequest(http.MethodGet, "/auth/star/"+endpoint, nil)
		w := httptest.NewRecorder()
		if endpoint == "start" {
			h.StarSignIn(w, r)
		} else {
			h.StarCallback(w, r)
		}
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("got %d", w.Code)
		}
		if len(w.Result().Cookies()) != 0 {
			t.Fatal("unconfigured identity provider issued cookies")
		}
		if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Referrer-Policy") != "no-referrer" {
			t.Fatal("login response may leak authorization parameters")
		}
	}
}
