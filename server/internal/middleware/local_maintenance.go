package middleware

import (
	"net/http"
	"os"
)

// LocalMaintenance protects the native API while the instance controller owns a checkpoint.
func LocalMaintenance(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if os.Getenv("MULTICA_SINGLE_OWNER") == "true" {
			path := os.Getenv("MULTICA_MAINTENANCE_FILE")
			if path != "" {
				_, err := os.Stat(path)
				if err == nil || !os.IsNotExist(err) {
					permitted := r.Method == http.MethodGet && (r.URL.Path == "/health" || r.URL.Path == "/healthz" || r.URL.Path == "/api/config" || r.URL.Path == "/auth/local/status")
					if !permitted {
						w.Header().Set("Retry-After", "5")
						writeError(w, http.StatusServiceUnavailable, "instance is in maintenance; retry when it completes")
						return
					}
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}
