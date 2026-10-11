package artifactcapture

import (
	"context"
	"errors"
	"io"
	"os"
	"sync"
)

// PreparedBytes owns a private spool. Its fingerprint is available before any
// object-store write so the caller can persist a content pin in its transaction.
// The spool is never exposed as a path or writable file to domain code.
type PreparedBytes struct {
	mu          sync.Mutex
	file        *os.File
	sizeBytes   int64
	contentHash string
	written     bool
	closeErr    error
}

func (p *PreparedBytes) SizeBytes() int64    { return p.sizeBytes }
func (p *PreparedBytes) ContentHash() string { return p.contentHash }

// PrepareBytes performs no storage I/O and does not close the source reader.
// Callers authorize and reserve their bounded transfer before this call, and
// check source close/identity errors before accepting the returned fingerprint.
func PrepareBytes(ctx context.Context, reader io.Reader, tempDir string, expectedSize int64, expectedHash string) (*PreparedBytes, error) {
	if reader == nil || expectedSize < 0 || expectedSize > MaxBytes {
		return nil, captureError("invalid_source", "The source reader or declared size is invalid.", false)
	}
	if expectedHash != "" && !validHash(expectedHash) {
		return nil, captureError("invalid_hash", "The expected content fingerprint must be a lowercase SHA-256 value.", false)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	spool, size, hash, err := spoolReader(ctx, reader, tempDir, expectedSize)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		removeSpool(spool)
		return nil, err
	}
	if expectedHash != "" && expectedHash != hash {
		removeSpool(spool)
		return nil, captureError("source_changed", "The source no longer matches the fixed content.", false)
	}
	return &PreparedBytes{file: spool, sizeBytes: size, contentHash: hash}, nil
}

// Close removes only this server-local spool, never a source or stored object.
func (p *PreparedBytes) Close() error {
	if p == nil {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.file == nil {
		return p.closeErr
	}
	closeErr := p.file.Close()
	removeErr := os.Remove(p.file.Name())
	if errors.Is(removeErr, os.ErrNotExist) {
		removeErr = nil
	}
	p.file = nil
	p.closeErr = errors.Join(closeErr, removeErr)
	return p.closeErr
}

// writePrepared permits one write call per spool. After an ambiguous write,
// the owning transfer must reconcile its persisted key instead of uploading
// again. A new attempt gets a new durable key and a newly prepared spool.
func (c *Capturer) writePrepared(ctx context.Context, key, filename, contentType string, prepared *PreparedBytes) error {
	if prepared == nil {
		return captureError("invalid_payload", "No prepared content is available.", false)
	}
	prepared.mu.Lock()
	defer prepared.mu.Unlock()
	if prepared.file == nil || prepared.written {
		return captureError("prepared_bytes_unavailable", "Prepared content is closed or has already been submitted.", false)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	prepared.written = true
	if _, err := c.Store.UploadStream(ctx, key, &contextReader{ctx: ctx, reader: prepared.file}, prepared.sizeBytes, contentType, filename); err != nil {
		return captureError("capture_write_failed", "The fixed file copy could not be stored.", true)
	}
	return c.verify(ctx, key, prepared.sizeBytes, prepared.contentHash)
}
