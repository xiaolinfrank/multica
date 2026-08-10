package storage

import (
	"context"
	"io"
	"time"
)

type Storage interface {
	Upload(ctx context.Context, key string, data []byte, contentType string, filename string) (string, error)
	Delete(ctx context.Context, key string)
	// DeleteObject is Delete with the error surfaced — the channel-media
	// reconciler schedules retries on failure instead of assuming success.
	DeleteObject(ctx context.Context, key string) error
	DeleteKeys(ctx context.Context, keys []string)
	KeyFromURL(rawURL string) string
	// ObjectURL is the URL a successful Upload of key would return — a pure
	// function of configuration, so the media intent ledger can persist it
	// BEFORE the upload.
	ObjectURL(key string) string
	CdnDomain() string
	// GetReader streams an object back to the caller. Used by the attachment
	// preview proxy (GET /api/attachments/{id}/content) to bypass CloudFront
	// CORS and the inline/attachment Content-Disposition decision. Caller
	// must Close the returned reader.
	GetReader(ctx context.Context, key string) (io.ReadCloser, error)
}

type Presigner interface {
	PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error)
}

type DownloadPresigner interface {
	PresignGetWithContentDisposition(ctx context.Context, key string, ttl time.Duration, contentDisposition string) (string, error)
}

// FilePather is an optional capability a Storage backend implements when it
// is backed by a real filesystem and can return a local on-disk path for a
// storage key. The handler uses it to surface a "Copy file path" affordance
// on self-hosted local-disk (LocalStorage) deployments, where the audience
// shares the server's filesystem. S3/R2/MinIO do not implement it, so the
// attachment response's file_path stays empty there and the UI hides the
// button — the feature is opt-in by deployment shape, never appearing on the
// hosted product. Not the same surface as MUL-4899 (which blocks
// agent-authored file:// links in deliverables read across machines): this
// is a human copying the server's own uploads path for use on hosts that can
// actually open it.
type FilePather interface {
	GetFilePath(key string) string
}
