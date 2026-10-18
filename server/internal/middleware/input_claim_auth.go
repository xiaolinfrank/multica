package middleware

import (
	"net/http"
	"strings"

	"github.com/multica-ai/multica/server/internal/util"
)

// InputClaimAuth admits existing daemon credentials only on the four exact
// bounded read/ack surfaces. A failed daemon authentication never falls back
// to a user identity. Route handlers still validate runtime/task/dispatch/pin.
func InputClaimAuth(regular, daemon func(http.Handler) http.Handler) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		userHandler := regular(next)
		daemonHandler := daemon(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.Header.Get("Authorization"), "Bearer mdt_") && isInputClaimEndpoint(r.Method, r.URL.Path) {
				daemonHandler.ServeHTTP(w, r)
				return
			}
			userHandler.ServeHTTP(w, r)
		})
	}
}
func isInputClaimEndpoint(method, path string) bool {
	parts := strings.Split(path, "/")
	uuidAt := func(i int) bool {
		if i >= len(parts) {
			return false
		}
		id, err := util.ParseUUID(parts[i])
		return err == nil && id.Valid
	}
	if len(parts) == 5 && parts[1] == "api" && parts[2] == "tasks" && uuidAt(3) {
		return method == http.MethodGet && parts[4] == "input-manifest" || method == http.MethodPost && parts[4] == "input-preparation"
	}
	if len(parts) == 9 && parts[1] == "api" && parts[2] == "cockpit" {
		if parts[3] == "issues" && uuidAt(4) && parts[5] == "input-manifest" && parts[6] == "versions" && uuidAt(7) && parts[8] == "items" {
			return method == http.MethodGet
		}
	}
	return len(parts) == 8 && parts[1] == "api" && parts[2] == "cockpit" && parts[3] == "inputs" && uuidAt(4) && parts[5] == "versions" && uuidAt(6) && parts[7] == "download-link" && method == http.MethodPost
}
