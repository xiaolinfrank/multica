package middleware

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestLocalMaintenanceBoundary(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "maintenance.json")
	t.Setenv("MULTICA_SINGLE_OWNER", "true")
	t.Setenv("MULTICA_MAINTENANCE_FILE", marker)
	h := LocalMaintenance(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	call := func(method, path string) int {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(method, path, nil))
		return w.Code
	}
	if call("POST", "/api/projects") != 204 {
		t.Fatal("unpaused instance was blocked")
	}
	if e := os.WriteFile(marker, []byte("{}"), 0600); e != nil {
		t.Fatal(e)
	}
	for _, p := range []string{"/api/projects", "/auth/local/recover", "/ws"} {
		if call("POST", p) != 503 {
			t.Fatalf("maintenance accepted %s", p)
		}
	}
	if call("GET", "/api/projects") != 503 || call("GET", "/api/config") != 204 {
		t.Fatal("only explicit readiness reads may bypass maintenance")
	}
	t.Setenv("MULTICA_SINGLE_OWNER", "false")
	if call("POST", "/api/projects") != 204 {
		t.Fatal("existing deployment policy changed")
	}
}
