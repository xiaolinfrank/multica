package artifactcapture

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"sync"
)

// OpenVerified reads a fixed object once and returns only the verified bytes.
// The private spool bounds memory and makes later storage changes irrelevant
// to this response. Callers authorize the descriptor before calling this
// method, keep all storage I/O outside database locks, and close the result.
func (c *Capturer) OpenVerified(ctx context.Context, key string, size int64, hash string) (io.ReadSeekCloser, error) {
	if err := c.requirePrivateStorage(); err != nil {
		return nil, err
	}
	if !validKey(key) || size < 0 || size > MaxBytes || !validHash(hash) {
		return nil, captureError("invalid_payload", "The fixed artifact identity or fingerprint is invalid.", false)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	input, err := c.Store.GetReader(ctx, key)
	if err != nil {
		return nil, captureError("capture_unavailable", "The fixed artifact copy could not be read.", true)
	}
	spool, err := os.CreateTemp(c.TempDir, "multica-artifact-verified-*")
	if err != nil {
		_ = input.Close()
		return nil, captureError("capture_spool_unavailable", "Temporary artifact storage is unavailable.", true)
	}
	retained := false
	defer func() {
		if !retained {
			removeSpool(spool)
		}
	}()
	digest := sha256.New()
	read, readErr := io.Copy(io.MultiWriter(spool, digest), io.LimitReader(&contextReader{ctx: ctx, reader: input}, size+1))
	closeErr := input.Close()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if readErr != nil || closeErr != nil {
		return nil, captureError("capture_verify_failed", "The fixed artifact copy could not be verified.", true)
	}
	if read != size || hex.EncodeToString(digest.Sum(nil)) != hash {
		return nil, captureError("capture_mismatch", "The stored artifact copy does not match the fixed version.", false)
	}
	if _, err := spool.Seek(0, io.SeekStart); err != nil {
		return nil, captureError("capture_spool_unavailable", "The verified artifact copy could not be read.", true)
	}
	retained = true
	return &verifiedReader{ctx: ctx, file: spool}, nil
}

type verifiedReader struct {
	ctx       context.Context
	file      *os.File
	closeOnce sync.Once
	closeErr  error
}

func (r *verifiedReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.file.Read(buffer)
}

func (r *verifiedReader) Seek(offset int64, whence int) (int64, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.file.Seek(offset, whence)
}

func (r *verifiedReader) Close() error {
	r.closeOnce.Do(func() {
		closeErr := r.file.Close()
		removeErr := os.Remove(r.file.Name())
		if errors.Is(removeErr, os.ErrNotExist) {
			removeErr = nil
		}
		r.closeErr = errors.Join(closeErr, removeErr)
	})
	return r.closeErr
}
