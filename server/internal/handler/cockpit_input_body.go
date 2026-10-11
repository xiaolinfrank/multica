package handler

import (
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/multica-ai/multica/server/internal/service"
)

// Validate wire identities before passing them into domain transactions. The
// domain separately validates permissions, revisions and immutable intent.
func validateCockpitInputBody(w http.ResponseWriter, body any) bool {
	ids := map[string]string{}
	optional := map[string]*string{}
	texts := map[string]struct {
		value string
		max   int
	}{}
	revision := int64(0)
	hasRevision := false
	command := ""
	needsCommand := true
	zeroRevision := false
	switch in := body.(type) {
	case *service.CockpitInputCreateInput:
		command = in.CommandKey
		optional["project_id"] = in.ProjectID
		optional["origin_issue_id"] = in.OriginIssueID
		texts["title"] = struct {
			value string
			max   int
		}{in.Title, 512}
		texts["description"] = struct {
			value string
			max   int
		}{in.Description, 16000}
	case *service.CockpitInputEditInput:
		needsCommand = false
		revision = in.ExpectedRevision
		hasRevision = true
		texts["title"] = struct {
			value string
			max   int
		}{in.Title, 512}
		texts["description"] = struct {
			value string
			max   int
		}{in.Description, 16000}
	case *service.CockpitInputArchiveInput:
		needsCommand = false
		revision = in.ExpectedRevision
		hasRevision = true
	case *service.CockpitInputVersionSubmitInput:
		command = in.CommandKey
		revision = in.ExpectedRevision
		hasRevision = true
		count := 0
		if in.Source.Upload != nil {
			count++
			s := in.Source.Upload
			texts["filename"] = struct {
				value string
				max   int
			}{s.Filename, 255}
			if s.SizeBytes == nil || *s.SizeBytes < 0 || *s.SizeBytes > service.CockpitInputMaxFileBytes {
				return inputBodyError(w, "invalid size_bytes")
			}
			if s.ClientSHA256 != nil && !inputHashValid(*s.ClientSHA256) {
				return inputBodyError(w, "invalid client_sha256")
			}
		}
		if in.Source.NASFile != nil {
			count++
			ids["root_id"] = in.Source.NASFile.RootID
		}
		if in.Source.Attachment != nil {
			count++
			ids["issue_id"] = in.Source.Attachment.IssueID
			ids["attachment_id"] = in.Source.Attachment.AttachmentID
		}
		if in.Source.ArtifactVersion != nil {
			count++
			ids["artifact_id"] = in.Source.ArtifactVersion.ArtifactID
			ids["artifact_version_id"] = in.Source.ArtifactVersion.VersionID
		}
		matching := (in.Source.Kind == "upload" && in.Source.Upload != nil) || (in.Source.Kind == "nas_file" && in.Source.NASFile != nil) || (in.Source.Kind == "attachment" && in.Source.Attachment != nil) || (in.Source.Kind == "artifact_version" && in.Source.ArtifactVersion != nil)
		if count != 1 || !matching {
			return inputBodyError(w, "source must have exactly its declared branch")
		}
		if in.InitialReference != nil {
			ids["reference_key"] = in.InitialReference.ReferenceKey
			ids["meeting_id"] = in.InitialReference.MeetingID
			optional["agenda_id"] = in.InitialReference.AgendaID
			if !inputPurposeValid(in.InitialReference.Purpose) {
				return inputBodyError(w, "invalid purpose")
			}
		}
	case *service.CockpitInputRestartInput:
		command = in.CommandKey
		revision = in.ExpectedRevision
		hasRevision = true
		optional["previous_transfer_id"] = in.PreviousTransferID
		texts["reason"] = struct {
			value string
			max   int
		}{in.Reason, 16000}
		if in.Mode != "retry_source" && in.Mode != "upload_matching_bytes" {
			return inputBodyError(w, "invalid restart mode")
		}
	case *service.CockpitInputFinalizeInput:
		command = in.CommandKey
		revision = in.ExpectedRevision
		hasRevision = true
		if !inputHashValid(in.ExpectedContentHash) {
			return inputBodyError(w, "invalid expected_content_hash")
		}
	case *service.CockpitInputAbandonInput:
		command = in.CommandKey
		revision = in.ExpectedRevision
		hasRevision = true
		texts["reason"] = struct {
			value string
			max   int
		}{in.Reason, 16000}
	case *service.CockpitInputReferenceCreateInput:
		command = in.CommandKey
		ids["input_version_id"] = in.InputVersionID
		optional["agenda_id"] = in.AgendaID
		if !inputPurposeValid(in.Purpose) {
			return inputBodyError(w, "invalid purpose")
		}
	case *service.CockpitInputReferenceRemoveInput:
		command = in.CommandKey
	case *service.CockpitInputManifestSaveInput:
		command = in.CommandKey
		revision = in.ExpectedRevision
		hasRevision = true
		zeroRevision = true
		texts["note"] = struct {
			value string
			max   int
		}{in.Note, 16000}
		versions := make([]string, 0, len(in.Items))
		for _, item := range in.Items {
			versions = append(versions, item.InputVersionID)
			if !inputPurposeValid(item.Purpose) {
				return inputBodyError(w, "invalid purpose")
			}
		}
		if !cockpitInputIDs(w, versions, 0, service.CockpitInputManifestMaxItems, "input_version_id") {
			return false
		}
	case *service.CockpitInputNASBrowseInput:
		needsCommand = false
		if in.PageSize == 0 {
			in.PageSize = service.CockpitInputPageSize
		}
		if in.PageSize < 1 || in.PageSize > service.CockpitInputMaxPageSize {
			return inputBodyError(w, "invalid page_size")
		}
		texts["q"] = struct {
			value string
			max   int
		}{in.Query, 512}
		texts["cursor"] = struct {
			value string
			max   int
		}{in.Cursor, 4096}
		texts["relative_directory"] = struct {
			value string
			max   int
		}{in.RelativeDirectory, 4096}
	case *service.CockpitRunInputPreparationInput:
		needsCommand = false
		ids["manifest_version_id"] = in.ManifestVersionID
		if !inputHashValid(in.ManifestHash) {
			return inputBodyError(w, "invalid manifest_hash")
		}
		if in.State != "preparing" && in.State != "required_ready" && in.State != "failed" {
			return inputBodyError(w, "invalid preparation state")
		}
		if !cockpitInputIDs(w, in.PreparedInputVersionIDs, 0, service.CockpitInputManifestMaxItems, "prepared_input_version_ids") {
			return false
		}
	default:
		return inputBodyError(w, "unsupported input command")
	}
	if needsCommand {
		ids["command_key"] = command
	}
	for name, raw := range ids {
		if _, ok := parseUUIDOrBadRequest(w, raw, name); !ok {
			return false
		}
	}
	for name, raw := range optional {
		if raw != nil {
			if _, ok := parseUUIDOrBadRequest(w, *raw, name); !ok {
				return false
			}
		}
	}
	if hasRevision && (revision < 0 || (!zeroRevision && revision < 1)) {
		return inputBodyError(w, "invalid expected_revision")
	}
	for name, text := range texts {
		if !utf8.ValidString(text.value) || len(text.value) > text.max {
			return inputBodyError(w, name+" exceeds its UTF-8 limit")
		}
	}
	return true
}
func inputBodyError(w http.ResponseWriter, message string) bool {
	writeError(w, http.StatusBadRequest, message)
	return false
}
func inputPurposeValid(s string) bool {
	return s == "material" || s == "recording" || s == "supporting"
}
func inputHashValid(s string) bool { return len(s) == 64 && strings.Trim(s, "0123456789abcdef") == "" }
