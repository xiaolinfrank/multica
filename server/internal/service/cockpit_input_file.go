package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/multica-ai/multica/server/internal/artifactcapture"
	"github.com/multica-ai/multica/server/internal/storage"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ReadCockpitInputFile authorizes one immutable version without touching its
// storage provider. A stored current copy is authoritative; a missing copy is
// never silently replaced by rereading the original mutable source.
func (s *IssueService) ReadCockpitInputFile(ctx context.Context, p CockpitInputQuery) (CockpitInputFile, error) {
	var out CockpitInputFile
	tx, q, a, err := s.beginInputRead(ctx, p.CockpitInputRead)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	v, err := q.GetCockpitInputVersion(ctx, db.GetCockpitInputVersionParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, ID: p.VersionID})
	if err != nil {
		return out, inputReadNotFound(err)
	}
	allowed, err := inputReadableVersions(ctx, q, p.CockpitInputRead, a, []db.CockpitInputVersion{v})
	if err != nil {
		return out, err
	}
	if !allowed[v.ID] {
		return out, inputError("permission_revoked", "This fixed input version is not authorized for the current principal.")
	}
	out, err = s.inputFileDescriptor(ctx, q, v)
	if err != nil {
		return CockpitInputFile{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CockpitInputFile{}, err
	}
	return out, nil
}

// inputFileDescriptor is also used by the private maintenance worker after it
// has loaded an exact owned, ready version. It performs no provider I/O.
func (s *IssueService) inputFileDescriptor(ctx context.Context, q *db.Queries, v db.CockpitInputVersion) (CockpitInputFile, error) {
	var out CockpitInputFile
	if v.CaptureState != "ready" || !v.PinnedSizeBytes.Valid || !v.ContentHash.Valid || !v.PinnedAt.Valid ||
		v.PinnedSizeBytes.Int64 < 0 || v.PinnedSizeBytes.Int64 > CockpitInputMaxFileBytes || !inputHashValid(v.ContentHash.String) {
		return out, inputError("input_not_ready", "This input version does not have a ready fixed copy.")
	}
	out = CockpitInputFile{WorkspaceID: util.UUIDToString(v.WorkspaceID), InputID: util.UUIDToString(v.InputID), VersionID: util.UUIDToString(v.ID),
		Filename: v.Filename, ContentType: v.ContentType, ContentHash: v.ContentHash.String, SizeBytes: v.PinnedSizeBytes.Int64, VersionRevision: v.Revision}
	if v.CurrentTransferID.Valid {
		t, e := q.GetCockpitInputTransfer(ctx, db.GetCockpitInputTransferParams{WorkspaceID: v.WorkspaceID, InputID: v.InputID, VersionID: v.ID, ID: v.CurrentTransferID})
		if e != nil {
			return CockpitInputFile{}, inputReadNotFound(e)
		}
		key, e := artifactcapture.InputTargetKey(artifactcapture.InputTarget{WorkspaceID: out.WorkspaceID, VersionID: out.VersionID, TransferID: util.UUIDToString(t.ID), Filename: v.Filename, ContentType: v.ContentType})
		if e != nil {
			return CockpitInputFile{}, e
		}
		if t.State != "verified" || t.WorkspaceDeletedAt.Valid || t.IoOutcome.String != "verified" || !t.IoFinishedAt.Valid ||
			!t.ContentHash.Valid || t.ContentHash.String != out.ContentHash || !t.PinnedSizeBytes.Valid || t.PinnedSizeBytes.Int64 != out.SizeBytes || t.OwnedStorageKey != key {
			return CockpitInputFile{}, inputError("input_copy_unavailable", "The fixed input copy does not match this version.")
		}
		out.Origin, out.StorageKey = "input", key
	} else if v.SourceKind == "artifact_version" && v.SourceArtifactID.Valid && v.SourceArtifactVersionID.Valid {
		if v.PayloadKind == "text" {
			if out.SizeBytes > CockpitArtifactMaxTextBytes {
				return CockpitInputFile{}, inputError("invalid_input", "The fixed text input exceeds its supported size.")
			}
			original, e := q.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: v.WorkspaceID, ArtifactID: v.SourceArtifactID, ID: v.SourceArtifactVersionID})
			if e != nil {
				return CockpitInputFile{}, inputReadNotFound(e)
			}
			if original.CaptureStatus != "ready" || original.PayloadKind != "text" || !original.Content.Valid ||
				!original.SizeBytes.Valid || original.SizeBytes.Int64 != out.SizeBytes || !original.ContentHash.Valid || original.ContentHash.String != out.ContentHash {
				return CockpitInputFile{}, inputError("input_copy_unavailable", "The original fixed text version is unavailable.")
			}
			out.Origin, out.Text = "text", &original.Content.String
		} else {
			original, e := q.ReadCockpitArtifactFile(ctx, db.ReadCockpitArtifactFileParams{WorkspaceID: v.WorkspaceID, ArtifactID: v.SourceArtifactID, ID: v.SourceArtifactVersionID})
			if e != nil {
				return CockpitInputFile{}, inputReadNotFound(e)
			}
			if !original.StorageKey.Valid || !original.SizeBytes.Valid || original.SizeBytes.Int64 != out.SizeBytes || !original.ContentHash.Valid || original.ContentHash.String != out.ContentHash {
				return CockpitInputFile{}, inputError("input_copy_unavailable", "The original fixed artifact file is unavailable.")
			}
			out.Origin, out.StorageKey = "artifact_version", original.StorageKey.String
		}
	} else {
		return CockpitInputFile{}, inputError("input_copy_unavailable", "No fixed copy is recorded for this input version.")
	}
	if out.Origin == "input" && !s.inputFileCaptureAvailable() || out.Origin == "artifact_version" && (s.CockpitArtifactCapturer == nil || !storage.SupportsPrivateArtifactFiles(s.CockpitArtifactCapturer.Store)) {
		return CockpitInputFile{}, inputError("private_storage_required", "This fixed file requires its private storage provider before it can be downloaded.")
	}
	return out, nil
}

// OpenCockpitInputFile keeps both storage reads and spooling outside database
// transactions. The reservation covers the returned reader's entire lifetime.
func (s *IssueService) OpenCockpitInputFile(ctx context.Context, p CockpitInputQuery) (CockpitInputFile, io.ReadSeekCloser, error) {
	file, err := s.ReadCockpitInputFile(ctx, p)
	if err != nil {
		return CockpitInputFile{}, nil, err
	}
	release, err := s.inputIOBudget.reserve(ctx, file.SizeBytes)
	if err != nil {
		return CockpitInputFile{}, nil, err
	}
	ioctx, cancel := context.WithTimeout(ctx, cockpitInputIOTimeout)
	retained := false
	defer func() {
		if !retained {
			cancel()
			release()
		}
	}()
	reader, err := s.inputOpenFixedDescriptor(ioctx, file)
	if err != nil {
		return CockpitInputFile{}, nil, err
	}
	// A permission change or a newer restored copy cannot be crossed by a late
	// storage response, even when the fixed content hash remains unchanged.
	current, err := s.ReadCockpitInputFile(ioctx, p)
	if err == nil && (current.Origin != file.Origin || current.StorageKey != file.StorageKey || current.ContentHash != file.ContentHash || current.SizeBytes != file.SizeBytes) {
		err = inputError("input_changed", "The input copy changed during verification. Read the current version again.")
	}
	if err != nil {
		return CockpitInputFile{}, nil, errors.Join(err, reader.Close())
	}
	retained = true
	return file, &inputBudgetReader{ReadSeekCloser: reader, ctx: ioctx, cancel: cancel, release: release}, nil
}

func (s *IssueService) inputOpenFixedDescriptor(ctx context.Context, file CockpitInputFile) (io.ReadSeekCloser, error) {
	var err error
	var reader io.ReadSeekCloser
	switch file.Origin {
	case "text":
		if file.Text == nil || !utf8.ValidString(*file.Text) || int64(len(*file.Text)) != file.SizeBytes {
			return nil, inputError("input_content_mismatch", "The fixed text bytes no longer match their content pin.")
		}
		digest := sha256.Sum256([]byte(*file.Text))
		if hex.EncodeToString(digest[:]) != file.ContentHash {
			return nil, inputError("input_content_mismatch", "The fixed text bytes no longer match their content pin.")
		}
		reader = inputTextReader{strings.NewReader(*file.Text)}
	case "input":
		if s.CockpitInputCapturer == nil {
			return nil, inputError("storage_unavailable", "Input storage is not configured.")
		}
		reader, err = s.CockpitInputCapturer.OpenVerifiedInput(ctx, file.StorageKey, file.SizeBytes, file.ContentHash)
	case "artifact_version":
		if s.CockpitArtifactCapturer == nil {
			return nil, inputError("storage_unavailable", "Artifact storage is not configured.")
		}
		reader, err = s.CockpitArtifactCapturer.OpenVerified(ctx, file.StorageKey, file.SizeBytes, file.ContentHash)
	default:
		err = inputError("input_copy_unavailable", "The input copy kind is unsupported.")
	}
	if err != nil {
		return nil, err
	}
	return reader, nil
}

type inputTextReader struct{ *strings.Reader }

func (inputTextReader) Close() error { return nil }

type inputBudgetReader struct {
	io.ReadSeekCloser
	ctx      context.Context
	cancel   context.CancelFunc
	release  func()
	once     sync.Once
	closeErr error
}

func (r *inputBudgetReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.ReadSeekCloser.Read(p)
}
func (r *inputBudgetReader) Seek(offset int64, whence int) (int64, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.ReadSeekCloser.Seek(offset, whence)
}
func (r *inputBudgetReader) Close() error {
	r.once.Do(func() { r.closeErr = r.ReadSeekCloser.Close(); r.cancel(); r.release() })
	return r.closeErr
}
