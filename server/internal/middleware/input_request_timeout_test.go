package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestInputStreamingDeadlineExemptionsStayExact(t *testing.T) {
	id := "10000000-0000-4000-8000-000000000001"
	bytes := "/api/cockpit/inputs/" + id + "/versions/" + id + "/transfers/" + id + "/bytes"
	download := "/api/cockpit/input-files/" + id + "/download"
	for _, tc := range []struct {
		name, method, path string
		exempt             bool
	}{
		{"raw upload", http.MethodPut, bytes, true},
		{"signed download", http.MethodGet, download, true},
		{"metadata", http.MethodGet, strings.TrimSuffix(bytes, "/bytes"), false},
		{"finalize", http.MethodPost, strings.TrimSuffix(bytes, "/bytes") + "/finalize", false},
		{"wrong method", http.MethodPost, bytes, false},
		{"suffix", http.MethodPut, bytes + "/extra", false},
		{"invalid identity", http.MethodPut, strings.Replace(bytes, id, "not-an-id", 1), false},
		{"nil identity", http.MethodPut, strings.Replace(bytes, id, "00000000-0000-0000-0000-000000000000", 1), false},
		{"unsigned metadata", http.MethodPost, strings.TrimSuffix(download, "/download") + "/download-link", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := RequestTimeout(time.Minute)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
				_, bounded := r.Context().Deadline()
				if bounded == tc.exempt {
					t.Fatalf("request deadline present=%v, expected exemption=%v", bounded, tc.exempt)
				}
			}))
			h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(tc.method, tc.path, nil))
		})
	}
}
