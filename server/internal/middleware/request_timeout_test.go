package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRequestTimeout_ShortRequestGetsDeadline(t *testing.T) {
	var gotDeadline bool
	var deadline time.Time
	h := RequestTimeout(5*time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		d, ok := r.Context().Deadline()
		gotDeadline = ok
		deadline = d
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/issues", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if !gotDeadline {
		t.Fatal("short API request was not given a deadline")
	}
	if !deadline.After(time.Now()) {
		t.Fatalf("deadline %v is not in the future", deadline)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected handler to run and return 200, got %d", rec.Code)
	}
}

func TestRequestTimeout_LongLivedRequestsExempt(t *testing.T) {
	// Every entry must NOT receive a deadline: WS upgrades and streaming
	// downloads must outlive any fixed request timeout.
	cases := []struct {
		name    string
		method  string
		path    string
		headers map[string]string
	}{
		{"user websocket path", http.MethodGet, "/ws", nil},
		{"daemon websocket path", http.MethodGet, "/api/daemon/ws", nil},
		{"websocket upgrade header", http.MethodGet, "/api/anything", map[string]string{"Upgrade": "websocket"}},
		{"uploads", http.MethodGet, "/uploads/file.bin", nil},
		{"avatars", http.MethodGet, "/api/avatars/sig/img.png", nil},
		{"attachment download", http.MethodGet, "/api/attachments/123/download", nil},
		{"attachment signed download", http.MethodGet, "/api/attachments/123/signed-download", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var gotDeadline bool
			h := RequestTimeout(time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, gotDeadline = r.Context().Deadline()
				// A request without a deadline still has the original
				// (non-deadline) context — verify it is not the
				// deadline-bearing one we'd attach.
				w.WriteHeader(http.StatusOK)
			}))

			req := httptest.NewRequest(c.method, c.path, nil)
			for k, v := range c.headers {
				req.Header.Set(k, v)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			if gotDeadline {
				t.Fatalf("%s: long-lived request must not receive a deadline", c.name)
			}
		})
	}
}

func TestRequestTimeout_HealthCheckExemptFromDeadlineLeak(t *testing.T) {
	// /healthz etc. should get a deadline too (they hit the DB for readiness),
	// proving the middleware applies broadly and the exempt set is narrow.
	var gotDeadline bool
	h := RequestTimeout(5*time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, gotDeadline = r.Context().Deadline()
	}))
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	h.ServeHTTP(httptest.NewRecorder(), req)
	if !gotDeadline {
		t.Fatal("/healthz should receive a deadline")
	}
}

// TestRequestTimeout_PropagatesCancellation confirms the deadline shows up as
// Done() after the timeout elapses, which is what unblocks a pgxpool query
// blocked on a stalled Postgres.
func TestRequestTimeout_PropagatesCancellation(t *testing.T) {
	done := make(chan struct{})
	h := RequestTimeout(20*time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(time.Second):
			t.Error("context was not cancelled at the deadline")
		}
		close(done)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/issues", nil)
	h.ServeHTTP(httptest.NewRecorder(), req)

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not observe cancellation in time")
	}
}

// guard against accidental import of context into the test of the
// middleware's own package compile.
var _ = context.Background
