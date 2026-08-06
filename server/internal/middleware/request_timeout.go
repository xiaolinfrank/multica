package middleware

import (
	"context"
	"net/http"
	"strings"
	"time"
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
	// File downloads / streaming responses.
	case strings.HasPrefix(p, "/uploads/"),
		strings.HasPrefix(p, "/api/avatars/"),
		strings.Contains(p, "/attachments/"): // covers .../download and .../signed-download
		return true
	}
	return false
}
