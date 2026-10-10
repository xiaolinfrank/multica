package handler

import (
	"errors"
	"mime"
	"net/http"
	"net/url"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/artifactcapture"
	"github.com/multica-ai/multica/server/internal/artifactdownload"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/storage"
)

func (h *Handler) cockpitArtifactFilesReady(w http.ResponseWriter) bool {
	if h.IssueService == nil || !h.IssueService.CockpitArtifactBackendReady {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "artifacts_unavailable", "error": "artifact services are not available"})
		return false
	}
	return true
}

func (h *Handler) authenticatedCockpitArtifactFile(w http.ResponseWriter, r *http.Request) (service.CockpitArtifactFile, string, bool) {
	var empty service.CockpitArtifactFile
	if !h.cockpitArtifactFilesReady(w) {
		return empty, "", false
	}
	ws, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return empty, "", false
	}
	member, ok := h.requireWorkspaceMember(w, r, uuidToString(ws), "artifact not found")
	if !ok {
		return empty, "", false
	}
	artifact, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "artifactId"), "artifact id")
	if !ok {
		return empty, "", false
	}
	version, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "versionId"), "version id")
	if !ok {
		return empty, "", false
	}
	file, err := h.IssueService.ReadCockpitArtifactFile(r.Context(), ws, artifact, version)
	if writeCockpitActionError(w, r, err) {
		return empty, "", false
	}
	return file, uuidToString(member.UserID), true
}

func (h *Handler) cockpitArtifactCapturer(w http.ResponseWriter) (*artifactcapture.Capturer, bool) {
	if !storage.SupportsPrivateArtifactFiles(h.Storage) {
		writeFeatureDisabled(w, "private_storage_required", "Fixed artifact files require a storage provider with a private artifact namespace.")
		return nil, false
	}
	store, ok := h.Storage.(artifactcapture.Store)
	if !ok || store == nil {
		writeFeatureDisabled(w, "storage_not_configured", "Artifact storage is not configured.")
		return nil, false
	}
	return &artifactcapture.Capturer{Store: store}, true
}

func writeCockpitArtifactReadError(w http.ResponseWriter, err error) {
	message := "The fixed artifact content is unavailable. Read its current status before trying again."
	var failure *artifactcapture.Error
	if errors.As(err, &failure) {
		message = failure.Message
	}
	writeJSON(w, http.StatusConflict, map[string]string{"code": "artifact_content_unavailable", "error": message})
}

// Recheck authorization and the same fixed descriptor after storage I/O. A
// slow object read must not authorize a later version or a departed member.
func (h *Handler) confirmCockpitArtifactFile(w http.ResponseWriter, r *http.Request, before service.CockpitArtifactFile, userID string) bool {
	if _, err := h.getWorkspaceMember(r.Context(), userID, before.WorkspaceID); err != nil {
		writeError(w, http.StatusForbidden, "artifact access is no longer available")
		return false
	}
	after, err := h.IssueService.ReadCockpitArtifactFile(r.Context(), parseUUID(before.WorkspaceID), parseUUID(before.ArtifactID), parseUUID(before.VersionID))
	if writeCockpitActionError(w, r, err) {
		return false
	}
	// Review-only revision changes do not change the immutable file.
	before.VersionRevision, after.VersionRevision = 0, 0
	if before != after {
		writeError(w, http.StatusConflict, "artifact file identity changed; request a new download link")
		return false
	}
	return true
}

func (h *Handler) GetCockpitArtifactDownloadLink(w http.ResponseWriter, r *http.Request) {
	file, userID, ok := h.authenticatedCockpitArtifactFile(w, r)
	if !ok {
		return
	}
	// Issuing a capability is a bounded metadata read, not an assertion that
	// storage is online. Redemption verifies the actual bytes before serving.
	if _, ok := h.cockpitArtifactCapturer(w); !ok {
		return
	}
	signer, err := artifactdownload.New(auth.JWTSecret())
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "Artifact download signing is unavailable.")
		return
	}
	token, expires, err := signer.Mint(artifactdownload.Claims{WorkspaceID: file.WorkspaceID, ArtifactID: file.ArtifactID,
		VersionID: file.VersionID, ContentHash: file.ContentHash, UserID: userID}, time.Now())
	if err != nil {
		writeError(w, http.StatusConflict, "Artifact download identity is invalid.")
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	writeJSON(w, http.StatusOK, service.CockpitArtifactDownloadLink{WorkspaceID: file.WorkspaceID, ArtifactID: file.ArtifactID, VersionID: file.VersionID,
		URL: "/api/cockpit/artifact-files/" + file.VersionID + "/download?token=" + url.QueryEscape(token), ExpiresAt: expires.UTC().Format(time.RFC3339)})
}

// DownloadCockpitArtifactFile keeps an authenticated direct-download surface.
func (h *Handler) DownloadCockpitArtifactFile(w http.ResponseWriter, r *http.Request) {
	file, userID, ok := h.authenticatedCockpitArtifactFile(w, r)
	if ok {
		h.serveCockpitArtifactFile(w, r, file, userID)
	}
}

// DownloadCockpitArtifactSignedFile is public at the router level. The token
// grants one file only, and membership is checked again at redemption time.
func (h *Handler) DownloadCockpitArtifactSignedFile(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if !h.cockpitArtifactFilesReady(w) {
		return
	}
	signer, err := artifactdownload.New(auth.JWTSecret())
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "Artifact download signing is unavailable.")
		return
	}
	tokens := r.URL.Query()["token"]
	if len(tokens) != 1 {
		writeError(w, http.StatusForbidden, "invalid or expired artifact download link")
		return
	}
	claims, err := signer.Verify(tokens[0], time.Now())
	if err != nil || claims.VersionID != chi.URLParam(r, "versionId") {
		writeError(w, http.StatusForbidden, "invalid or expired artifact download link")
		return
	}
	if _, err := h.getWorkspaceMember(r.Context(), claims.UserID, claims.WorkspaceID); err != nil {
		writeError(w, http.StatusForbidden, "artifact access is no longer available")
		return
	}
	// The signer has verified these canonical UUIDs as our own round-trip.
	file, err := h.IssueService.ReadCockpitArtifactFile(r.Context(), parseUUID(claims.WorkspaceID), parseUUID(claims.ArtifactID), parseUUID(claims.VersionID))
	if writeCockpitActionError(w, r, err) {
		return
	}
	if file.ContentHash != claims.ContentHash {
		writeError(w, http.StatusConflict, "artifact file identity changed; request a new download link")
		return
	}
	h.serveCockpitArtifactFile(w, r, file, claims.UserID)
}

func (h *Handler) serveCockpitArtifactFile(w http.ResponseWriter, r *http.Request, file service.CockpitArtifactFile, userID string) {
	capture, ok := h.cockpitArtifactCapturer(w)
	if !ok {
		return
	}
	reader, err := capture.OpenVerified(r.Context(), file.StorageKey, file.SizeBytes, file.ContentHash)
	if err != nil {
		writeCockpitArtifactReadError(w, err)
		return
	}
	defer reader.Close()
	if !h.confirmCockpitArtifactFile(w, r, file, userID) {
		return
	}
	contentType, _, err := mime.ParseMediaType(file.ContentType)
	if err != nil || contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", storage.AttachmentContentDisposition(file.Filename))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("ETag", `"`+file.ContentHash+`"`)
	h.setAttachmentPreviewSecurityHeaders(w)
	http.ServeContent(w, r, file.Filename, time.Time{}, reader)
}
