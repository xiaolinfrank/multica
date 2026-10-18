package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestInputClaimAuthStaysOnExactReadAndAckSurfaces(t *testing.T) {
	const id = "0195fa33-1ea5-7000-8000-000000000001"
	tests := []struct {
		method, path string
		daemon       bool
	}{
		{"GET", "/api/tasks/" + id + "/input-manifest", true},
		{"POST", "/api/tasks/" + id + "/input-preparation", true},
		{"GET", "/api/cockpit/issues/" + id + "/input-manifest/versions/" + id + "/items", true},
		{"POST", "/api/cockpit/inputs/" + id + "/versions/" + id + "/download-link", true},
		{"POST", "/api/cockpit/inputs", false},
		{"PUT", "/api/cockpit/inputs/" + id + "/versions/" + id + "/transfers/" + id + "/bytes", false},
		{"POST", "/api/cockpit/input-spaces/" + id + "/entries", false},
		{"PUT", "/api/cockpit/issues/" + id + "/input-manifest", false},
		{"GET", "/api/tasks/" + id + "/input-preparation", false},
		{"GET", "/api/tasks/" + id + "/input-manifest/", false},
		{"GET", "/api/tasks/not-a-uuid/input-manifest", false},
		{"GET", "/api/tasks/" + id + "/messages", false},
	}
	for _, test := range tests {
		t.Run(test.method+test.path, func(t *testing.T) {
			selected := ""
			regular := func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { selected = "regular"; w.WriteHeader(401) })
			}
			daemon := func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { selected = "daemon"; w.WriteHeader(403) })
			}
			h := InputClaimAuth(regular, daemon)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("rejected authentication reached business handler") }))
			r := httptest.NewRequest(test.method, test.path, nil)
			r.Header.Set("Authorization", "Bearer mdt_invalid")
			h.ServeHTTP(httptest.NewRecorder(), r)
			want := "regular"
			if test.daemon {
				want = "daemon"
			}
			if selected != want {
				t.Fatalf("selected %s, want %s", selected, want)
			}
			r.Header.Set("Authorization", "Bearer mat_task")
			h.ServeHTTP(httptest.NewRecorder(), r)
			if selected != "regular" {
				t.Fatal("task token bypassed ordinary authentication")
			}
		})
	}
}
