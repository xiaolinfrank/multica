package artifactcapture

import (
	"context"
	"fmt"
	"io"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/multica-ai/multica/server/internal/storage"
)

// InputTarget contains only a new transfer's immutable destination. It does
// not imply an attachment, a review, a NAS source, or a business authorization.
type InputTarget struct {
	WorkspaceID string
	VersionID   string
	TransferID  string
	Filename    string
	ContentType string
}

// InputTargetKey is pure; the service records this key before reading bytes.
func InputTargetKey(target InputTarget) (string, error) {
	if !canonicalUUID(target.WorkspaceID) || !canonicalUUID(target.VersionID) || !canonicalUUID(target.TransferID) {
		return "", captureError("invalid_identity", "Input capture requires canonical workspace, version and transfer identities.", false)
	}
	if target.Filename == "" || len(target.Filename) > 1024 || !utf8.ValidString(target.Filename) ||
		strings.ContainsAny(target.Filename, "/\\") || strings.IndexFunc(target.Filename, unicode.IsControl) >= 0 ||
		target.ContentType == "" || len(target.ContentType) > 255 || !utf8.ValidString(target.ContentType) || strings.IndexFunc(target.ContentType, unicode.IsControl) >= 0 {
		return "", captureError("invalid_source", "The input filename or content type is invalid.", false)
	}
	return fmt.Sprintf("workspaces/%s/input-versions/%s/%s", target.WorkspaceID, target.VersionID, target.TransferID), nil
}

func (c *Capturer) requirePrivateInputStorage() error {
	if c == nil || c.Store == nil {
		return captureError("storage_unavailable", "Input storage is not configured.", true)
	}
	if !storage.SupportsPrivateInputFiles(c.Store) {
		return captureError("private_storage_required", "Fixed input files require a storage provider with a private input namespace.", false)
	}
	return nil
}

// WriteInputAndVerify uses exactly the spool whose hash the domain has pinned.
// It neither publishes a version nor erases an ambiguous object. The caller
// must persist the owned key, then the content pin, before invoking this method.
func (c *Capturer) WriteInputAndVerify(ctx context.Context, target InputTarget, prepared *PreparedBytes) error {
	key, err := InputTargetKey(target)
	if err != nil {
		return err
	}
	if err := c.requirePrivateInputStorage(); err != nil {
		return err
	}
	return c.writePrepared(ctx, key, target.Filename, target.ContentType, prepared)
}

func validInputKey(key string) bool {
	if !validKey(key) {
		return false
	}
	parts := strings.Split(key, "/")
	return len(parts) == 5 && parts[0] == "workspaces" && parts[2] == "input-versions" && canonicalUUID(parts[1]) && canonicalUUID(parts[3]) && canonicalUUID(parts[4])
}

// VerifyInput reconciles an existing owned object without uploading it again.
func (c *Capturer) VerifyInput(ctx context.Context, key string, size int64, hash string) error {
	if err := c.requirePrivateInputStorage(); err != nil {
		return err
	}
	if !validInputKey(key) {
		return captureError("invalid_payload", "The fixed input object identity is invalid.", false)
	}
	return c.verify(ctx, key, size, hash)
}

// OpenVerifiedInput returns the same verified spool used for this read, so
// storage replacement after verification cannot change the response bytes.
func (c *Capturer) OpenVerifiedInput(ctx context.Context, key string, size int64, hash string) (io.ReadSeekCloser, error) {
	if err := c.requirePrivateInputStorage(); err != nil {
		return nil, err
	}
	if !validInputKey(key) {
		return nil, captureError("invalid_payload", "The fixed input object identity is invalid.", false)
	}
	return c.openVerified(ctx, key, size, hash)
}
