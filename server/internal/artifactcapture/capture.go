// Package artifactcapture copies an explicitly selected attachment into a
// verified version object. Callers own durable intents, leases and publication.
package artifactcapture

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
)

const MaxBytes = int64(500 << 20)

// Store is already implemented by the platform's local and S3 storage backends.
type Store interface {
	GetReader(context.Context, string) (io.ReadCloser, error)
	UploadStream(context.Context, string, io.Reader, int64, string, string) (string, error)
}

type Source struct {
	AttachmentID string
	StorageKey   string
	Filename     string
	ContentType  string
	SizeBytes    int64
}

type Request struct {
	WorkspaceID string
	VersionID   string
	AttemptID   string
	Source      Source
	// ExpectedHash is optional for the initial snapshot; a retry can pin known bytes.
	ExpectedHash string
}

type Result struct {
	StorageKey   string
	Filename     string
	ContentType  string
	SizeBytes    int64
	ContentHash  string
	AttachmentID string
}

type Error struct {
	Code      string
	Message   string
	Retryable bool
}

func (e *Error) Error() string { return e.Message }

func captureError(code, message string, retryable bool) error {
	return &Error{Code: code, Message: message, Retryable: retryable}
}

func canonicalUUID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id != uuid.Nil && id.String() == value
}

func validHash(value string) bool {
	bytes, err := hex.DecodeString(value)
	return err == nil && len(bytes) == sha256.Size && strings.ToLower(value) == value
}

func validKey(key string) bool {
	return key != "" && !strings.HasPrefix(key, "/") && path.Clean(key) == key && key != "." && key != ".." && !strings.HasPrefix(key, "../") &&
		!strings.Contains(key, "://") && !strings.ContainsAny(key, "\\\x00\r\n")
}

// TargetKey is pure so the owning service can persist its cleanup intent before any I/O.
func TargetKey(request Request) (string, error) {
	if !canonicalUUID(request.WorkspaceID) || !canonicalUUID(request.VersionID) || !canonicalUUID(request.AttemptID) || !canonicalUUID(request.Source.AttachmentID) {
		return "", captureError("invalid_identity", "Artifact capture requires canonical workspace, version, attempt and attachment identities.", false)
	}
	if !validKey(request.Source.StorageKey) || request.Source.SizeBytes < 0 || request.Source.SizeBytes > MaxBytes {
		return "", captureError("invalid_source", "The attachment source or size is invalid.", false)
	}
	if request.Source.Filename == "" || len(request.Source.Filename) > 1024 || !utf8.ValidString(request.Source.Filename) ||
		strings.ContainsAny(request.Source.Filename, "/\\") || strings.IndexFunc(request.Source.Filename, unicode.IsControl) >= 0 ||
		request.Source.ContentType == "" || len(request.Source.ContentType) > 255 || strings.IndexFunc(request.Source.ContentType, unicode.IsControl) >= 0 {
		return "", captureError("invalid_source", "The attachment filename or content type is invalid.", false)
	}
	if request.ExpectedHash != "" && !validHash(request.ExpectedHash) {
		return "", captureError("invalid_hash", "The expected content fingerprint must be a lowercase SHA-256 value.", false)
	}
	return fmt.Sprintf("workspaces/%s/artifact-versions/%s/%s%s", request.WorkspaceID, request.VersionID, request.AttemptID, path.Ext(request.Source.Filename)), nil
}

type Capturer struct {
	Store Store
	// TempDir is an optional server-local spool directory, never a NAS destination.
	TempDir string
}

// Capture performs no database operations and never publishes a version. The
// caller must have recorded TargetKey under this attempt's durable intent first.
// Failed or abandoned objects remain owned by that intent for reconciliation.
func (c *Capturer) Capture(ctx context.Context, request Request) (Result, error) {
	key, err := TargetKey(request)
	if err != nil {
		return Result{}, err
	}
	if c == nil || c.Store == nil {
		return Result{}, captureError("storage_unavailable", "Artifact storage is not configured.", true)
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	reader, err := c.Store.GetReader(ctx, request.Source.StorageKey)
	if err != nil {
		return Result{}, captureError("source_unavailable", "The selected attachment could not be read.", true)
	}
	spool, size, hash, readErr := spoolReader(ctx, reader, c.TempDir, request.Source.SizeBytes)
	closeErr := reader.Close()
	if readErr != nil {
		return Result{}, readErr
	}
	defer removeSpool(spool)
	if closeErr != nil {
		return Result{}, captureError("source_unavailable", "The attachment read did not finish successfully.", true)
	}
	if request.ExpectedHash != "" && request.ExpectedHash != hash {
		return Result{}, captureError("source_changed", "The selected attachment no longer matches the expected content.", false)
	}
	if _, err := c.Store.UploadStream(ctx, key, &contextReader{ctx: ctx, reader: spool}, size, request.Source.ContentType, request.Source.Filename); err != nil {
		return Result{}, captureError("capture_write_failed", "The fixed artifact copy could not be stored.", true)
	}
	if err := c.Verify(ctx, key, size, hash); err != nil {
		return Result{}, err
	}
	return Result{StorageKey: key, Filename: request.Source.Filename, ContentType: request.Source.ContentType,
		SizeBytes: size, ContentHash: hash, AttachmentID: request.Source.AttachmentID}, nil
}

// Verify checks the stored object, rather than treating a successful upload call as evidence.
func (c *Capturer) Verify(ctx context.Context, key string, size int64, hash string) error {
	if c == nil || c.Store == nil {
		return captureError("storage_unavailable", "Artifact storage is not configured.", true)
	}
	if !validKey(key) || size < 0 || size > MaxBytes || !validHash(hash) {
		return captureError("invalid_payload", "The fixed artifact identity or fingerprint is invalid.", false)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	reader, err := c.Store.GetReader(ctx, key)
	if err != nil {
		return captureError("capture_unavailable", "The fixed artifact copy could not be read back.", true)
	}
	defer reader.Close()
	digest := sha256.New()
	read, err := io.Copy(digest, io.LimitReader(&contextReader{ctx: ctx, reader: reader}, size+1))
	if err != nil {
		return captureError("capture_verify_failed", "The fixed artifact copy could not be verified.", true)
	}
	if read != size || hex.EncodeToString(digest.Sum(nil)) != hash {
		return captureError("capture_mismatch", "The stored artifact copy does not match the captured bytes.", false)
	}
	return nil
}

// Spooling bounds memory and prevents a changing source from being read twice during capture.
func spoolReader(ctx context.Context, reader io.Reader, tempDir string, expectedSize int64) (*os.File, int64, string, error) {
	spool, err := os.CreateTemp(tempDir, "multica-artifact-capture-*")
	if err != nil {
		return nil, 0, "", captureError("capture_spool_unavailable", "Temporary artifact storage is unavailable.", true)
	}
	digest := sha256.New()
	size, err := io.Copy(io.MultiWriter(spool, digest), io.LimitReader(&contextReader{ctx: ctx, reader: reader}, expectedSize+1))
	if err != nil {
		removeSpool(spool)
		return nil, 0, "", captureError("source_unavailable", "The selected attachment could not be read completely.", true)
	}
	if size != expectedSize {
		removeSpool(spool)
		return nil, 0, "", captureError("source_changed", "The attachment size changed during capture.", false)
	}
	if _, err := spool.Seek(0, io.SeekStart); err != nil {
		removeSpool(spool)
		return nil, 0, "", captureError("capture_spool_unavailable", "The temporary artifact copy could not be read.", true)
	}
	return spool, size, hex.EncodeToString(digest.Sum(nil)), nil
}

func removeSpool(file *os.File) {
	_ = file.Close()
	_ = os.Remove(file.Name())
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(buffer)
}
