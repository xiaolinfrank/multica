package handler

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/workspacecontext"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// This opt-in mode uses the native user, workspace, cookies and CLI consent.
// Existing installations without this switch retain their authentication policy.
func singleOwnerMode() bool { return os.Getenv("MULTICA_SINGLE_OWNER") == "true" }

var localLoginName = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,63}$`)

func localSecret() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func localDigest(s string) string { d := sha256.Sum256([]byte(s)); return hex.EncodeToString(d[:]) }
func (h *Handler) localRequest(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if !singleOwnerMode() {
		writeError(w, 404, "local account mode is disabled")
		return false
	}
	if !auth.IsStarLocalRequest(r) {
		writeError(w, 403, "local account is available only on this Mac")
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, e := url.Parse(h.cfg.AppURL)
		if e != nil || origin != u.Scheme+"://"+u.Host {
			writeError(w, 403, "untrusted account origin")
			return false
		}
	}
	if h.DB == nil {
		writeError(w, 503, "local account storage unavailable")
		return false
	}
	return true
}

type localAccountRequest struct {
	LoginName    string `json:"login_name"`
	DisplayName  string `json:"display_name"`
	Password     string `json:"password"`
	RecoveryCode string `json:"recovery_code"`
}

func readLocalAccount(w http.ResponseWriter, r *http.Request) (localAccountRequest, bool) {
	var v localAccountRequest
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	d.DisallowUnknownFields()
	if d.Decode(&v) != nil || len(v.Password) > 1024 || utf8.RuneCountInString(v.Password) > 256 || len(v.RecoveryCode) > 128 {
		writeError(w, 400, "invalid local account request")
		return v, false
	}
	v.LoginName = strings.ToLower(strings.TrimSpace(v.LoginName))
	v.DisplayName = strings.TrimSpace(v.DisplayName)
	return v, true
}
func (h *Handler) LocalAccountStatus(w http.ResponseWriter, r *http.Request) {
	if !h.localRequest(w, r) {
		return
	}
	var n int
	if e := h.DB.QueryRow(r.Context(), "SELECT count(*) FROM single_owner_account").Scan(&n); e != nil {
		writeError(w, 503, "local account storage unavailable")
		return
	}
	response := map[string]any{"single_owner": true, "initialized": n == 1}
	if n == 0 && os.Getenv("MULTICA_ADOPT_OWNER_ID") != "" {
		response["adopting"] = true
		var name string
		if h.DB.QueryRow(r.Context(), `SELECT name FROM "user" WHERE id::text=$1`, os.Getenv("MULTICA_ADOPT_OWNER_ID")).Scan(&name) == nil {
			response["display_name"] = name
		}
	}
	writeJSON(w, 200, response)
}
func validSetupToken(r *http.Request) bool {
	p := os.Getenv("MULTICA_SETUP_TOKEN_FILE")
	s, e := os.Lstat(p)
	if e != nil || !s.Mode().IsRegular() || s.Mode().Perm()&0077 != 0 || time.Since(s.ModTime()) > 30*time.Minute {
		return false
	}
	b, e := os.ReadFile(p)
	if e != nil || len(b) > 256 {
		return false
	}
	want := strings.TrimSpace(string(b))
	got := r.Header.Get("X-Setup-Token")
	return len(want) >= 64 && subtle.ConstantTimeCompare([]byte(want), []byte(got)) == 1
}
func (h *Handler) SetupLocalAccount(w http.ResponseWriter, r *http.Request) {
	if !h.localRequest(w, r) {
		return
	}
	if !validSetupToken(r) {
		writeError(w, 403, "open the current local setup link from the launcher")
		return
	}
	v, ok := readLocalAccount(w, r)
	if !ok {
		return
	}
	if !localLoginName.MatchString(v.LoginName) || v.DisplayName == "" || len([]rune(v.DisplayName)) > 100 || utf8.RuneCountInString(v.Password) < 12 {
		writeError(w, 400, "use a login name, display name and password of at least 12 characters")
		return
	}
	tx, e := h.TxStarter.Begin(r.Context())
	if e != nil {
		writeError(w, 503, "local account storage unavailable")
		return
	}
	defer tx.Rollback(r.Context())
	if _, e = tx.Exec(r.Context(), "SELECT pg_advisory_xact_lock(70344792103)"); e != nil {
		writeError(w, 503, "local account lock unavailable")
		return
	}
	var n int
	if e = tx.QueryRow(r.Context(), `SELECT count(*) FROM "user"`).Scan(&n); e != nil {
		writeError(w, 503, "local account storage unavailable")
		return
	}
	q := h.Queries.WithTx(tx)
	var localCount int
	if e = tx.QueryRow(r.Context(), "SELECT count(*) FROM single_owner_account").Scan(&localCount); e != nil {
		writeError(w, 503, "local account storage unavailable")
		return
	}
	if localCount != 0 {
		writeError(w, 409, "this instance already has an owner; sign in or recover it")
		return
	}
	var user db.User
	var ws db.Workspace
	if n == 0 {
		user, e = q.CreateUser(r.Context(), db.CreateUserParams{Name: v.DisplayName, Email: "owner+" + localSecret() + "@helixhelm.local"})
		if e == nil {
			ws, e = q.CreateWorkspace(r.Context(), db.CreateWorkspaceParams{Name: "我的工作空间", Slug: "personal", IssuePrefix: "HH", Context: strToText(workspacecontext.ForCreate(nil))})
		}
		if e == nil {
			_, e = q.CreateMember(r.Context(), db.CreateMemberParams{WorkspaceID: ws.ID, UserID: user.ID, Role: "owner"})
		}
	} else if n == 1 && os.Getenv("MULTICA_ADOPT_OWNER_ID") != "" && os.Getenv("MULTICA_ADOPT_WORKSPACE_ID") != "" {
		owner, valid := parseUUIDOrBadRequest(w, os.Getenv("MULTICA_ADOPT_OWNER_ID"), "migration owner")
		if !valid {
			return
		}
		workspace, valid := parseUUIDOrBadRequest(w, os.Getenv("MULTICA_ADOPT_WORKSPACE_ID"), "migration workspace")
		if !valid {
			return
		}
		var members int
		e = tx.QueryRow(r.Context(), "SELECT count(*) FROM member WHERE user_id=$1 AND workspace_id=$2 AND role='owner'", owner, workspace).Scan(&members)
		if e == nil && members == 1 {
			user, e = q.GetUser(r.Context(), owner)
			if e == nil {
				ws, e = q.GetWorkspace(r.Context(), workspace)
			}
		} else {
			e = errors.New("migration owner binding differs")
		}
	} else {
		writeError(w, 409, "this instance already has an owner; use its explicit migration or recovery flow")
		return
	}
	if e != nil {
		writeError(w, 500, "could not initialize the selected local owner")
		return
	}
	if e = issuestatus.Ensure(r.Context(), q, ws.ID); e != nil {
		writeError(w, 500, "could not initialize workspace statuses")
		return
	}
	if user, e = q.MarkUserOnboarded(r.Context(), user.ID); e != nil {
		writeError(w, 500, "could not finish local owner setup")
		return
	}
	recovery := localSecret()
	_, e = tx.Exec(r.Context(), `INSERT INTO single_owner_account(singleton,user_id,workspace_id,login_name,password_hash,recovery_hash,credential_version) VALUES(1,$1,$2,$3,$4,$5,$6)`, user.ID, ws.ID, v.LoginName, auth.HashLocalPassword(v.Password), localDigest(recovery), localSecret())
	if e != nil {
		writeError(w, 500, "could not store local credential")
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		writeError(w, 500, "could not commit local owner")
		return
	}
	h.localAccountSession(w, r, user, recovery)
}
func (h *Handler) localAccountSession(w http.ResponseWriter, r *http.Request, user db.User, recovery string) {
	token, e := h.issueJWT(user)
	if e != nil {
		writeError(w, 500, "could not establish local session")
		return
	}
	if e = auth.SetAuthCookies(w, token); e != nil {
		writeError(w, 500, "could not set local session")
		return
	}
	response := map[string]any{"token": token, "user": h.userToResponse(user)}
	if recovery != "" {
		response["recovery_code"] = recovery
	}
	writeJSON(w, 200, response)
}
func (h *Handler) LoginLocalAccount(w http.ResponseWriter, r *http.Request) {
	h.authenticateLocalAccount(w, r, false)
}
func (h *Handler) RecoverLocalAccount(w http.ResponseWriter, r *http.Request) {
	h.authenticateLocalAccount(w, r, true)
}
func (h *Handler) authenticateLocalAccount(w http.ResponseWriter, r *http.Request, recovering bool) {
	if !h.localRequest(w, r) {
		return
	}
	v, ok := readLocalAccount(w, r)
	if !ok {
		return
	}
	tx, e := h.TxStarter.Begin(r.Context())
	if e != nil {
		writeError(w, 503, "local account storage unavailable")
		return
	}
	defer tx.Rollback(r.Context())
	var userID, login, passwordHash, recoveryHash string
	var blocked *time.Time
	e = tx.QueryRow(r.Context(), `SELECT user_id::text,login_name,password_hash,recovery_hash,blocked_until FROM single_owner_account WHERE singleton=1 FOR UPDATE`).Scan(&userID, &login, &passwordHash, &recoveryHash, &blocked)
	if errors.Is(e, pgx.ErrNoRows) {
		writeError(w, 409, "create the local owner first")
		return
	}
	if e != nil {
		writeError(w, 503, "local account storage unavailable")
		return
	}
	if blocked != nil && time.Now().Before(*blocked) {
		writeError(w, 429, "wait before trying the local account again")
		return
	}
	valid := false
	if recovering {
		valid = len(v.RecoveryCode) == 64 && subtle.ConstantTimeCompare([]byte(localDigest(v.RecoveryCode)), []byte(recoveryHash)) == 1 && utf8.RuneCountInString(v.Password) >= 12
	} else {
		valid = auth.CheckLocalPassword(passwordHash, v.Password) && v.LoginName == login
	}
	if !valid {
		_, e = tx.Exec(r.Context(), `UPDATE single_owner_account SET failed_attempts=failed_attempts+1,blocked_until=now()+CASE WHEN failed_attempts>=4 THEN interval '5 minutes' ELSE interval '1 second' END WHERE singleton=1`)
		if e == nil {
			e = tx.Commit(r.Context())
		}
		writeError(w, 401, "invalid local credential")
		return
	}
	recovery := ""
	if recovering {
		recovery = localSecret()
		_, e = tx.Exec(r.Context(), `UPDATE single_owner_account SET password_hash=$1,recovery_hash=$2,credential_version=$3,failed_attempts=0,blocked_until=NULL WHERE singleton=1`, auth.HashLocalPassword(v.Password), localDigest(recovery), localSecret())
		if e == nil {
			_, e = tx.Exec(r.Context(), `DELETE FROM personal_access_token WHERE user_id=$1`, parseUUID(userID))
		}
		if e == nil {
			_, e = tx.Exec(r.Context(), `DELETE FROM task_token WHERE user_id=$1`, parseUUID(userID))
		}
		if e == nil {
			_, e = tx.Exec(r.Context(), `DELETE FROM daemon_token WHERE workspace_id IN (SELECT workspace_id FROM member WHERE user_id=$1)`, parseUUID(userID))
		}
	} else {
		_, e = tx.Exec(r.Context(), `UPDATE single_owner_account SET failed_attempts=0,blocked_until=NULL WHERE singleton=1`)
	}
	if e != nil {
		writeError(w, 500, "could not update local credential")
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		writeError(w, 500, "could not commit local credential")
		return
	}
	if recovering {
		h.Hub.DisconnectUser(userID)
		h.DaemonHub.DisconnectAll()
	}
	user, e := h.Queries.GetUser(r.Context(), parseUUID(userID))
	if e != nil {
		writeError(w, 500, "local owner unavailable")
		return
	}
	h.localAccountSession(w, r, user, recovery)
}

// Only this mode adds credential-version revocation to native session tokens.
func (h *Handler) ValidateLocalSession(ctx context.Context, claims jwt.MapClaims) bool {
	if !singleOwnerMode() {
		return true
	}
	if h.DB == nil {
		return false
	}
	var id, version string
	if e := h.DB.QueryRow(ctx, `SELECT user_id::text,credential_version FROM single_owner_account WHERE singleton=1`).Scan(&id, &version); e != nil {
		return false
	}
	return claims["sub"] == id && claims["local_owner_version"] == version
}
