package middleware

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

// RequestTimeout caps the lifetime of short, synchronous API requests so that
// a stalled downstream (historically: the colima VM freezing and Postgres
// going silent on 2026-08-06) degrades to a context cancellation / 5xx
// instead of pinning a pool connection and hanging the client until its own
// timeout fires. Without it, a PG stall saturates the 25-conn pool with hung
// queries and cascades into the "page loads but data never arrives" outage.
//
// The deadline propagates through r.Context() into every sqlc/pgxpool query,
// so a request blocked on an unresponsive DB is released at the deadline
// rather than waiting indefinitely.
//
// WebSocket upgrades and streaming downloads are exempt — they are
// legitimately long-lived and must not be torn down by a request deadline.
//
// The timeout applied by the router is generous (well above p99 for any JSON
// API call) so it only ever fires under failure, never in normal operation.
func RequestTimeout(timeout time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if isLongLivedRequest(r) {
				next.ServeHTTP(w, r)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), timeout)
			defer cancel()
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// isLongLivedRequest reports whether r is a WebSocket upgrade or a streaming
// download — endpoints that must outlive any fixed request deadline.
func isLongLivedRequest(r *http.Request) bool {
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return true
	}
	p := r.URL.Path
	switch {
	case p == "/ws", strings.HasPrefix(p, "/api/daemon/ws"):
		return true
	case r.Method == http.MethodGet && isCockpitArtifactDownloadPath(p):
		return true
	case isCockpitInputStreamRequest(r.Method, p):
		return true
	// File downloads / streaming responses.
	case strings.HasPrefix(p, "/uploads/"),
		strings.HasPrefix(p, "/api/avatars/"),
		strings.Contains(p, "/attachments/"): // covers .../download and .../signed-download
		return true
	// Large-file uploads. A ~20-24MB PDF on a slow client uplink can take
	// well over the 30s request deadline to stream in, which would cancel the
	// MultipartForm read and fail the upload with a 4xx/5xx. Uploads are
	// bounded by the handler's own 100MB MaxBytesReader, so exempting this
	// route from the deadline does not open an unbounded body.
	case p == "/api/upload-file":
		return true
	}
	return false
}

// These handlers enforce their own byte and I/O budgets. Other input metadata
// and command endpoints retain the normal short request deadline.
func isCockpitInputStreamRequest(method, path string) bool {
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(parts) < 5 || parts[0] != "api" || parts[1] != "cockpit" {
		return false
	}
	validID := func(raw string) bool {
		id, err := uuid.Parse(raw)
		return err == nil && id != uuid.Nil && id.String() == raw
	}
	if method == http.MethodGet && len(parts) == 5 && parts[2] == "input-files" && parts[4] == "download" {
		return validID(parts[3])
	}
	return method == http.MethodPut && len(parts) == 9 && parts[2] == "inputs" && parts[4] == "versions" && parts[6] == "transfers" && parts[8] == "bytes" &&
		validID(parts[3]) && validID(parts[5]) && validID(parts[7])
}

func isCockpitArtifactDownloadPath(path string) bool {
	if !strings.HasPrefix(path, "/api/cockpit/") {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	validID := func(raw string) bool {
		id, err := uuid.Parse(raw)
		return err == nil && id != uuid.Nil && id.String() == strings.ToLower(raw)
	}
	if len(parts) == 5 && parts[0] == "api" && parts[1] == "cockpit" && parts[2] == "artifact-files" && parts[4] == "download" {
		return validID(parts[3])
	}
	return len(parts) == 7 && parts[0] == "api" && parts[1] == "cockpit" && parts[2] == "artifacts" && parts[4] == "versions" && parts[6] == "download" && validID(parts[3]) && validID(parts[5])
}
