package handler

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

const cockpitInputStreamTimeout = 8 * time.Minute

// A context deadline alone cannot interrupt a blocked HTTP body read or socket
// write. Bind the same budget to the connection before acquiring an I/O slot.
func cockpitInputStreamDeadline(w http.ResponseWriter, r *http.Request, upload bool) (*http.Request, func(bool), bool) {
	controller := http.NewResponseController(w)
	setDeadline := controller.SetWriteDeadline
	direction := "download"
	if upload {
		setDeadline = controller.SetReadDeadline
		direction = "upload"
	}
	deadline := time.Now().Add(cockpitInputStreamTimeout)
	if earlier, ok := r.Context().Deadline(); ok && earlier.Before(deadline) {
		deadline = earlier
	}
	if r.Context().Err() != nil {
		deadline = time.Now()
	}
	if err := setDeadline(deadline); err != nil {
		// A wrapper that hides ResponseController support must not silently turn
		// this bounded stream into an unlimited request. Close HTTP/1 connections
		// rather than asking net/http to drain an unread request body for reuse.
		r.Close = true
		w.Header().Set("Connection", "close")
		slog.Error("input stream deadline unavailable", "direction", direction, "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "input_io_deadline_unavailable", "error": "The server cannot enforce the input transfer deadline."})
		return r, nil, false
	}
	ctx, cancel := context.WithDeadline(r.Context(), deadline)
	stopped := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		defer close(stopped)
		if err := setDeadline(time.Now()); err != nil {
			slog.Error("input stream cancellation deadline failed", "direction", direction, "error", err)
		}
	})
	var once sync.Once
	finish := func(complete bool) {
		once.Do(func() {
			if !stop() {
				<-stopped
			}
			// Preserve an expired deadline on failures. Clearing it would let
			// net/http block again while draining or flushing after this return.
			next := time.Now()
			if complete && ctx.Err() == nil && next.Before(deadline) {
				next = time.Time{}
			}
			if err := setDeadline(next); err != nil {
				slog.Error("input stream deadline cleanup failed", "direction", direction, "error", err)
			}
			cancel()
		})
	}
	if ctx.Err() != nil {
		finish(false)
		writeJSON(w, http.StatusRequestTimeout, map[string]string{"code": "input_stream_expired", "error": "The input transfer request has expired."})
		return r, nil, false
	}
	return r.WithContext(ctx), finish, true
}
