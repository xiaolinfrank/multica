package service

import (
	"context"
	"encoding/hex"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func inputHashValid(value string) bool {
	b, e := hex.DecodeString(value)
	return e == nil && len(b) == 32 && strings.ToLower(value) == value
}
func inputFilenameValid(value string) bool {
	return value != "" && value != "." && value != ".." && len(value) <= CockpitInputMaxFilenameBytes && utf8.ValidString(value) && !strings.ContainsAny(value, "/\\") && strings.IndexFunc(value, unicode.IsControl) < 0
}
func inputSourceValidate(in CockpitInputSourceInput) error {
	n := 0
	if in.Upload != nil {
		n++
	}
	if in.NASFile != nil {
		n++
	}
	if in.Attachment != nil {
		n++
	}
	if in.ArtifactVersion != nil {
		n++
	}
	if n != 1 {
		return inputError("invalid_input", "Choose one exact supported input source.")
	}
	switch in.Kind {
	case "upload":
		v := in.Upload
		if v == nil || !inputFilenameValid(v.Filename) || !utf8.ValidString(v.ContentType) || v.ContentType == "" || len(v.ContentType) > 255 || strings.IndexFunc(v.ContentType, unicode.IsControl) >= 0 || v.SizeBytes == nil || *v.SizeBytes < 0 || *v.SizeBytes > CockpitInputMaxFileBytes {
			return inputError("invalid_input", "Upload requires a safe filename, content type and explicit bounded byte size.")
		}
		if v.ClientSHA256 != nil && !inputHashValid(*v.ClientSHA256) {
			return inputError("invalid_input", "Client SHA-256 must be a lowercase 64-character fingerprint.")
		}
	case "nas_file":
		if in.NASFile == nil || in.NASFile.ObservationToken == "" || len(in.NASFile.ObservationToken) > 16000 {
			return inputError("invalid_input", "NAS capture requires the exact selected file observation.")
		}
		if _, e := inputKey(in.NASFile.RootID); e != nil {
			return e
		}
	case "attachment":
		if in.Attachment == nil {
			return inputError("invalid_input", "The attachment source is missing.")
		}
		if _, e := inputKey(in.Attachment.IssueID); e != nil {
			return e
		}
		if _, e := inputKey(in.Attachment.AttachmentID); e != nil {
			return e
		}
	case "artifact_version":
		if in.ArtifactVersion == nil {
			return inputError("invalid_input", "The fixed artifact source is missing.")
		}
		if _, e := inputKey(in.ArtifactVersion.ArtifactID); e != nil {
			return e
		}
		if _, e := inputKey(in.ArtifactVersion.VersionID); e != nil {
			return e
		}
	default:
		return inputError("invalid_input", "The input source kind is unsupported.")
	}
	return nil
}
func inputPurposeValid(p string) bool {
	return p == "material" || p == "recording" || p == "supporting"
}
func inputSafeSourceName(name string, version pgtype.UUID) string {
	if inputFilenameValid(name) {
		return name
	}
	return util.UUIDToString(version) + ".bin"
}

type cockpitInputSourceFacts struct {
	version      db.CreateCockpitInputVersionParams
	transferKind string
}

// Observe happens after actual actor/input/meeting admission, outside all DB
// write locks. Accepted observations are then rechecked in the short command TX.
func (s *IssueService) inputObserveSource(ctx context.Context, p CockpitInputRead, in CockpitInputSourceInput, a cockpitInputAuthority, versionID pgtype.UUID) (cockpitInputSourceFacts, error) {
	out := cockpitInputSourceFacts{version: db.CreateCockpitInputVersionParams{ID: versionID, SourceKind: in.Kind, PayloadKind: "file", CaptureState: "queued", Availability: "unknown"}, transferKind: "source_capture"}
	if err := inputSourceValidate(in); err != nil {
		return out, err
	}
	if p.ActorSource != "human" && in.Kind != "upload" && in.Kind != "attachment" {
		return out, inputError("permission_revoked", "A delegated task may only upload its own bytes or capture its own Issue attachment.")
	}
	if in.Kind != "artifact_version" && !s.inputFileCaptureAvailable() {
		return out, inputError("private_storage_required", "Fixed input copies require private input storage.")
	}
	switch in.Kind {
	case "upload":
		u := in.Upload
		out.transferKind = "direct_upload"
		out.version.CaptureState = "awaiting_upload"
		out.version.Filename = u.Filename
		out.version.ContentType = u.ContentType
		out.version.DeclaredSizeBytes = pgtype.Int8{Int64: *u.SizeBytes, Valid: true}
		if u.ClientSHA256 != nil {
			out.version.ClientSha256 = pgtype.Text{String: *u.ClientSHA256, Valid: true}
		}
	case "attachment":
		source := in.Attachment
		issue, err := inputKey(source.IssueID)
		if err != nil {
			return out, err
		}
		attachmentID, err := inputKey(source.AttachmentID)
		if err != nil {
			return out, err
		}
		if p.ActorSource != "human" && issue != a.Run.IssueID {
			return out, inputError("permission_revoked", "Only the task's exact source Issue attachment is authorized.")
		}
		if _, err := s.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: issue}); err != nil {
			return out, inputConvertError(err)
		}
		att, err := s.Queries.GetAttachment(ctx, db.GetAttachmentParams{WorkspaceID: p.WorkspaceID, ID: attachmentID})
		if err != nil {
			return out, inputConvertError(err)
		}
		if att.IssueID != issue {
			return out, inputError("permission_revoked", "The attachment does not belong to the selected source Issue.")
		}
		if att.SizeBytes < 0 || att.SizeBytes > CockpitInputMaxFileBytes {
			return out, inputError("invalid_input", "The selected attachment exceeds the supported input size.")
		}
		out.version.SourceAttachmentID = att.ID
		out.version.SourceAttachmentIssueID = issue
		out.version.Filename = inputSafeSourceName(att.Filename, versionID)
		out.version.ContentType = att.ContentType
		if out.version.ContentType == "" {
			out.version.ContentType = "application/octet-stream"
		}
		out.version.DeclaredSizeBytes = pgtype.Int8{Int64: att.SizeBytes, Valid: true}
	case "nas_file":
		if err := s.requireInputNAS(ctx, p); err != nil {
			return out, err
		}
		source := in.NASFile
		obs, err := s.CockpitInputNAS.ObserveInput(ctx, util.UUIDToString(p.WorkspaceID), source.RootID, source.RelativePath, inputActorScope(p), source.ObservationToken)
		if err != nil {
			return out, inputConvertError(err)
		}
		if obs.SizeBytes < 0 || obs.SizeBytes > CockpitInputMaxFileBytes {
			return out, inputError("invalid_input", "The selected NAS file exceeds the input limit.")
		}
		out.version.SourceRootID, err = inputReceiptID(obs.RootID)
		if err != nil {
			return out, err
		}
		out.version.SourceRootPath = pgtype.Text{String: obs.RootPath, Valid: true}
		out.version.SourceRelativePath = pgtype.Text{String: obs.RelativePath, Valid: true}
		out.version.SourceRootConfigHash = pgtype.Text{String: obs.RootConfigHash, Valid: true}
		out.version.SourceRootIdentity = pgtype.Text{String: obs.RootIdentity, Valid: true}
		out.version.SourceFileIdentity = pgtype.Text{String: obs.FileIdentity, Valid: true}
		out.version.SourceSize = pgtype.Int8{Int64: obs.SizeBytes, Valid: true}
		out.version.SourceMtimeNs = pgtype.Int8{Int64: obs.MtimeNS, Valid: true}
		out.version.DeclaredSizeBytes = out.version.SourceSize
		out.version.Filename = inputSafeSourceName(filepath.Base(obs.RelativePath), versionID)
		out.version.ContentType = "application/octet-stream"
	case "artifact_version":
		source := in.ArtifactVersion
		sourceVersionID, err := inputKey(source.VersionID)
		if err != nil {
			return out, err
		}
		artifactID, err := inputKey(source.ArtifactID)
		if err != nil {
			return out, err
		}
		rows, err := s.Queries.ListCockpitArtifactVersionMetadataByIDs(ctx, db.ListCockpitArtifactVersionMetadataByIDsParams{WorkspaceID: p.WorkspaceID, VersionIds: []pgtype.UUID{sourceVersionID}})
		if err != nil {
			return out, err
		}
		if len(rows) != 1 || rows[0].ArtifactID != artifactID {
			return out, inputError("not_found", "The selected fixed artifact version is unavailable.")
		}
		v := rows[0]
		if v.CaptureStatus != "ready" || !v.ContentHash.Valid || !inputHashValid(v.ContentHash.String) || !v.SizeBytes.Valid {
			return out, inputError("source_not_ready", "Select an artifact version whose exact bytes are fixed.")
		}
		if v.PayloadKind != "text" && v.PayloadKind != "attachment" {
			return out, inputError("invalid_input", "This artifact payload kind cannot be used as fixed input.")
		}
		out.transferKind = ""
		out.version.SourceArtifactID = v.ArtifactID
		out.version.SourceArtifactVersionID = v.ID
		out.version.CaptureState = "ready"
		out.version.PinnedSizeBytes = v.SizeBytes
		out.version.ContentHash = v.ContentHash
		out.version.PinnedAt = pgtype.Timestamptz{Time: time.Now().UTC().Truncate(time.Microsecond), Valid: true}
		out.version.ReadyAt = out.version.PinnedAt
		out.version.Filename = inputSafeSourceName(v.Filename, versionID)
		out.version.ContentType = v.ContentType
		if v.PayloadKind == "text" {
			out.version.PayloadKind = "text"
			out.version.Filename = util.UUIDToString(versionID) + ".txt"
		}
	}
	return out, nil
}
func inputStoredNASObservation(v db.CockpitInputVersion) cockpitnas.InputObservation {
	return cockpitnas.InputObservation{WorkspaceID: util.UUIDToString(v.WorkspaceID), RootID: util.UUIDToString(v.SourceRootID), RootPath: v.SourceRootPath.String, RootConfigHash: v.SourceRootConfigHash.String, RootIdentity: v.SourceRootIdentity.String, RelativePath: v.SourceRelativePath.String, FileIdentity: v.SourceFileIdentity.String, SizeBytes: v.SourceSize.Int64, MtimeNS: v.SourceMtimeNs.Int64}
}
