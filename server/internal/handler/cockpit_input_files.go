package handler

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/storage"
	"github.com/multica-ai/multica/server/internal/util"
)

const cockpitInputDownloadDomain = "cockpit-input-file-capability:v1:"

var errInputDownloadCapability = errors.New("invalid or expired input download link")

type cockpitInputDownloadClaims struct {
	WorkspaceID  string `json:"w"`
	InputID      string `json:"i"`
	VersionID    string `json:"v"`
	Hash         string `json:"h"`
	Size         int64  `json:"s"`
	OwnerID      string `json:"u"`
	ActorSource  string `json:"a"`
	IssuerKind   string `json:"k"`
	AgentID      string `json:"g,omitempty"`
	RunID        string `json:"r,omitempty"`
	TaskTokenID  string `json:"t,omitempty"`
	RuntimeID    string `json:"m,omitempty"`
	DispatchedAt string `json:"d,omitempty"`
	DaemonID     string `json:"daemon,omitempty"`
	Expires      int64  `json:"e"`
}

func inputCapabilityMAC(secret []byte, payload string) []byte {
	key := sha256.Sum256(append([]byte(cockpitInputDownloadDomain), secret...))
	mac := hmac.New(sha256.New, key[:])
	_, _ = mac.Write([]byte(payload))
	return mac.Sum(nil)
}
func (c cockpitInputDownloadClaims) query(now time.Time) (service.CockpitInputQuery, error) {
	var q service.CockpitInputQuery
	if c.Expires <= now.Unix() || c.Expires > now.Add(time.Minute).Unix() || !inputHashValid(c.Hash) || c.Size < 0 || c.Size > service.CockpitInputMaxFileBytes {
		return q, errInputDownloadCapability
	}
	for _, x := range []struct {
		raw string
		dst *pgtype.UUID
	}{{c.WorkspaceID, &q.WorkspaceID}, {c.InputID, &q.InputID}, {c.VersionID, &q.VersionID}, {c.OwnerID, &q.CredentialOwnerID}} {
		id, err := util.ParseUUID(x.raw)
		if err != nil || !id.Valid {
			return q, errInputDownloadCapability
		}
		*x.dst = id
	}
	q.ActorSource = c.ActorSource
	switch c.ActorSource {
	case "human":
		if c.IssuerKind != "human" {
			return q, errInputDownloadCapability
		}
		if c.AgentID != "" || c.RunID != "" || c.TaskTokenID != "" || c.RuntimeID != "" || c.DispatchedAt != "" || c.DaemonID != "" {
			return q, errInputDownloadCapability
		}
	case "task_token":
		if c.IssuerKind != "task_token" {
			return q, errInputDownloadCapability
		}
		if c.RuntimeID != "" || c.DispatchedAt != "" || c.DaemonID != "" {
			return q, errInputDownloadCapability
		}
		for _, x := range []struct {
			raw string
			dst *pgtype.UUID
		}{{c.AgentID, &q.AgentID}, {c.RunID, &q.RunID}, {c.TaskTokenID, &q.TaskTokenID}} {
			id, err := util.ParseUUID(x.raw)
			if err != nil || !id.Valid {
				return q, errInputDownloadCapability
			}
			*x.dst = id
		}
	case "daemon_claim":
		if !((c.IssuerKind == "daemon_token" && c.DaemonID != "") || (c.IssuerKind == "cloud_pat" && c.DaemonID == "")) {
			return q, errInputDownloadCapability
		}
		if c.TaskTokenID != "" {
			return q, errInputDownloadCapability
		}
		for _, x := range []struct {
			raw string
			dst *pgtype.UUID
		}{{c.AgentID, &q.AgentID}, {c.RunID, &q.RunID}, {c.RuntimeID, &q.RuntimeID}} {
			id, err := util.ParseUUID(x.raw)
			if err != nil || !id.Valid {
				return q, errInputDownloadCapability
			}
			*x.dst = id
		}
		at, err := time.Parse(time.RFC3339Nano, c.DispatchedAt)
		if err != nil {
			return q, errInputDownloadCapability
		}
		q.ClaimDispatchedAt = pgtype.Timestamptz{Time: at, Valid: true}
		q.TaskID = q.RunID
		q.TrustedDaemonID = c.DaemonID
	default:
		return q, errInputDownloadCapability
	}
	return q, nil
}
func mintCockpitInputCapability(secret []byte, c cockpitInputDownloadClaims, now time.Time) (string, error) {
	if len(secret) == 0 {
		return "", errInputDownloadCapability
	}
	c.Expires = now.Add(time.Minute).Unix()
	if _, err := c.query(now); err != nil {
		return "", err
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	payload := base64.RawURLEncoding.EncodeToString(raw)
	return payload + "." + base64.RawURLEncoding.EncodeToString(inputCapabilityMAC(secret, payload)), nil
}
func verifyCockpitInputCapability(secret []byte, token string, now time.Time) (cockpitInputDownloadClaims, service.CockpitInputQuery, error) {
	var c cockpitInputDownloadClaims
	var q service.CockpitInputQuery
	if len(secret) == 0 || len(token) > 4096 {
		return c, q, errInputDownloadCapability
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return c, q, errInputDownloadCapability
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(sig, inputCapabilityMAC(secret, parts[0])) {
		return c, q, errInputDownloadCapability
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(raw, &c) != nil {
		return c, q, errInputDownloadCapability
	}
	q, err = c.query(now)
	return c, q, err
}
func (h *Handler) GetCockpitInputDownloadLink(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRequest(w, r, "task_id", "runtime_id", "dispatched_at")
	if !ok {
		return
	}
	if !h.cockpitInputOptionalClaim(w, r, &q) {
		return
	}
	file, err := api.ReadCockpitInputFile(r.Context(), q)
	if writeCockpitInputError(w, r, err) {
		return
	}
	now := time.Now()
	c := cockpitInputDownloadClaims{WorkspaceID: file.WorkspaceID, InputID: file.InputID, VersionID: file.VersionID, Hash: file.ContentHash, Size: file.SizeBytes, OwnerID: uuidToString(q.CredentialOwnerID), ActorSource: q.ActorSource, IssuerKind: q.ActorSource, Expires: now.Add(time.Minute).Unix()}
	if q.ActorSource == "task_token" {
		c.AgentID = uuidToString(q.AgentID)
		c.RunID = uuidToString(q.RunID)
		c.TaskTokenID = uuidToString(q.TaskTokenID)
	}
	if q.ActorSource == "daemon_claim" {
		c.AgentID = uuidToString(q.AgentID)
		c.RunID = uuidToString(q.RunID)
		c.RuntimeID = uuidToString(q.RuntimeID)
		c.DaemonID = middleware.DaemonIDFromContext(r.Context())
		c.IssuerKind = "cloud_pat"
		if c.DaemonID != "" {
			c.IssuerKind = "daemon_token"
		}
		c.DispatchedAt = q.ClaimDispatchedAt.Time.UTC().Format(time.RFC3339Nano)
	}
	token, err := mintCockpitInputCapability(auth.JWTSecret(), c, now)
	if err != nil {
		writeError(w, http.StatusForbidden, "Input download requires a human or exact task identity.")
		return
	}
	w.Header().Set("Referrer-Policy", "no-referrer")
	writeCockpitInputResult(w, r, service.CockpitInputDownloadLink{WorkspaceID: file.WorkspaceID, InputID: file.InputID, VersionID: file.VersionID, ContentHash: file.ContentHash, SizeBytes: file.SizeBytes, URL: "/api/cockpit/input-files/" + file.VersionID + "/download?token=" + url.QueryEscape(token), ExpiresAt: time.Unix(c.Expires, 0).UTC().Format(time.RFC3339)}, nil)
}
func (h *Handler) DownloadCockpitInputSignedFile(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	api, ok := h.cockpitInputAPI(w, false)
	if !ok {
		return
	}
	params := r.URL.Query()
	tokens := params["token"]
	if len(params) != 1 || len(tokens) != 1 {
		writeError(w, http.StatusForbidden, errInputDownloadCapability.Error())
		return
	}
	claims, q, err := verifyCockpitInputCapability(auth.JWTSecret(), tokens[0], time.Now())
	if err != nil || claims.VersionID != chi.URLParam(r, "versionId") {
		writeError(w, http.StatusForbidden, errInputDownloadCapability.Error())
		return
	}
	// This service performs current principal authorization before I/O and owns
	// the shared finite spool reservation for all three fixed-content origins.
	if auth.IsTemporarilyDisabledUser(claims.OwnerID, "") {
		writeError(w, http.StatusForbidden, auth.TemporarilyDisabledUserError)
		return
	}
	if !h.confirmInputDaemonCapability(w, r, claims, q) {
		return
	}
	r, finish, ok := cockpitInputStreamDeadline(w, r, false)
	if !ok {
		return
	}
	complete := false
	defer func() {
		// Early authorization/storage errors also need their small JSON response
		// flushed before a failed-stream cleanup expires the write deadline.
		if !complete {
			complete = http.NewResponseController(w).Flush() == nil
		}
		finish(complete)
	}()
	file, reader, err := api.OpenCockpitInputFile(r.Context(), q)
	if writeCockpitInputError(w, r, err) {
		return
	}
	defer reader.Close()
	if !inputFileMatchesCapability(file, claims) {
		writeError(w, http.StatusConflict, "Input identity changed; request a new download link.")
		return
	}
	// Authorization can change during a slow object read. No bytes leave until
	// the same exact principal and immutable descriptor have been rechecked.
	current, err := api.ReadCockpitInputFile(r.Context(), q)
	if writeCockpitInputError(w, r, err) {
		return
	}
	if auth.IsTemporarilyDisabledUser(claims.OwnerID, "") {
		writeError(w, http.StatusForbidden, auth.TemporarilyDisabledUserError)
		return
	}
	if !h.confirmInputDaemonCapability(w, r, claims, q) {
		return
	}
	if !inputFileMatchesCapability(current, claims) {
		writeError(w, http.StatusConflict, "Input identity changed; request a new download link.")
		return
	}
	contentType, _, err := mime.ParseMediaType(file.ContentType)
	if err != nil || contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", storage.AttachmentContentDisposition(file.Filename))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("ETag", `"`+file.ContentHash+`"`)
	h.setAttachmentPreviewSecurityHeaders(w)
	http.ServeContent(w, r, file.Filename, time.Time{}, reader)
	// Flush under the write deadline too: ServeContent can leave its last
	// bytes in net/http's buffer even after its final reader call succeeds.
	complete = http.NewResponseController(w).Flush() == nil
}
func inputFileMatchesCapability(f service.CockpitInputFile, c cockpitInputDownloadClaims) bool {
	return f.WorkspaceID == c.WorkspaceID && f.InputID == c.InputID && f.VersionID == c.VersionID && f.ContentHash == c.Hash && f.SizeBytes == c.Size
}

func (h *Handler) confirmInputDaemonCapability(w http.ResponseWriter, r *http.Request, c cockpitInputDownloadClaims, q service.CockpitInputQuery) bool {
	if c.DaemonID == "" {
		return true
	}
	rt, err := h.Queries.GetAgentRuntime(r.Context(), q.RuntimeID)
	if err != nil || !rt.DaemonID.Valid || rt.DaemonID.String != c.DaemonID || rt.WorkspaceID != q.WorkspaceID || rt.OwnerID != q.CredentialOwnerID {
		writeError(w, http.StatusForbidden, "The original daemon runtime is no longer authorized.")
		return false
	}
	return true
}
