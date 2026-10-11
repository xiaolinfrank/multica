package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// Memory-only HTTP fixtures have no socket to deadline. Implement the same
// ResponseController contract explicitly; production has no recorder branch.
type inputDeadlineRecorder struct {
	http.ResponseWriter
	mu                          sync.Mutex
	readDeadline, writeDeadline time.Time
}

func (w *inputDeadlineRecorder) SetReadDeadline(at time.Time) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.readDeadline = at
	return nil
}
func (w *inputDeadlineRecorder) SetWriteDeadline(at time.Time) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.writeDeadline = at
	return nil
}
func (w *inputDeadlineRecorder) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func withInputRecorderDeadlines(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { h(&inputDeadlineRecorder{ResponseWriter: w}, r) }
}

func TestCockpitInputStreamDeadlineCapsAndRestoresOnlyCompletedStreams(t *testing.T) {
	for _, upload := range []bool{true, false} {
		name := "download"
		if upload {
			name = "upload"
		}
		t.Run(name, func(t *testing.T) {
			w := &inputDeadlineRecorder{ResponseWriter: httptest.NewRecorder()}
			before := time.Now()
			r, finish, ok := cockpitInputStreamDeadline(w, httptest.NewRequest("GET", "/", nil), upload)
			if !ok {
				t.Fatal("deadline-capable writer rejected")
			}
			at, has := r.Context().Deadline()
			if !has || at.Before(before.Add(8*time.Minute)) || at.After(time.Now().Add(8*time.Minute)) {
				t.Fatalf("unbounded stream context: %v", at)
			}
			finish(true)
			w.mu.Lock()
			got := w.writeDeadline
			if upload {
				got = w.readDeadline
			}
			w.mu.Unlock()
			if !got.IsZero() {
				t.Fatalf("completed stream retained its deadline: %v", got)
			}
		})
	}
}

func TestCockpitInputStreamDeadlineCancellationNeverClearsExpiredSocketDeadline(t *testing.T) {
	for _, complete := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		w := &inputDeadlineRecorder{ResponseWriter: httptest.NewRecorder()}
		r, finish, ok := cockpitInputStreamDeadline(w, httptest.NewRequest("PUT", "/", nil).WithContext(ctx), true)
		if !ok {
			t.Fatal("deadline-capable writer rejected")
		}
		cancel()
		<-r.Context().Done()
		finish(complete)
		w.mu.Lock()
		at := w.readDeadline
		w.mu.Unlock()
		if at.IsZero() || at.After(time.Now()) {
			t.Fatalf("cancelled stream regained unlimited socket I/O: %v", at)
		}
	}
}

func TestCockpitInputStreamDeadlineRejectsUnsupportedWriterAndExpiredRequest(t *testing.T) {
	w := httptest.NewRecorder()
	r, finish, ok := cockpitInputStreamDeadline(w, httptest.NewRequest("PUT", "/", nil), true)
	if ok || finish != nil || w.Code != 503 || !r.Close {
		t.Fatalf("unsupported transport accepted: ok=%v code=%d close=%v", ok, w.Code, r.Close)
	}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	rec := httptest.NewRecorder()
	bounded := &inputDeadlineRecorder{ResponseWriter: rec}
	_, finish, ok = cockpitInputStreamDeadline(bounded, httptest.NewRequest("GET", "/", nil).WithContext(ctx), false)
	if ok || finish != nil || rec.Code != 408 || !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatalf("expired request accepted: ok=%v code=%d", ok, rec.Code)
	}
	if bounded.writeDeadline.IsZero() || bounded.writeDeadline.After(time.Now()) {
		t.Fatal("expired transport deadline was cleared")
	}
}
