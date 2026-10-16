package handler

import (
	"errors"
	"net/http"

	"github.com/multica-ai/multica/server/internal/auth"
)

// OpenLocalDashboard reuses the authenticated native account and the native
// OpenClaw owner pairing CLI. Existing middleware owns authentication and CSRF.
func (h *Handler) OpenLocalDashboard(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if isMachineCredentialActor(r) {
		writeError(w, http.StatusForbidden, "this endpoint is only available to human actors")
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	if !auth.IsStarLocalRequest(r) {
		writeError(w, http.StatusForbidden, "local dashboard is available only on this Mac")
		return
	}
	if h.LocalDashboard == nil {
		writeError(w, http.StatusServiceUnavailable, "local dashboard is unavailable")
		return
	}
	link, err := h.LocalDashboard.OpenForUser(r.Context(), userID)
	if err != nil {
		status := http.StatusServiceUnavailable
		if errors.Is(err, auth.ErrStarDashboardOwner) {
			status = http.StatusForbidden
		}
		writeError(w, status, "local dashboard could not be opened for this account")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"browser_url": link})
}

// StarSignIn delegates authentication to the configured star account provider.
func (h *Handler) StarSignIn(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if h.StarOIDC == nil {
		writeError(w, http.StatusServiceUnavailable, "star sign-in is not configured or unavailable")
		return
	}
	destination := r.URL.Query().Get("destination")
	if destination == "openclaw" && !auth.IsStarLocalRequest(r) {
		writeError(w, http.StatusForbidden, "local dashboard sign-in is available only on this Mac")
		return
	}
	target, cookie, err := h.StarOIDC.Begin(r.URL.Query().Get("next"), destination)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "star sign-in is unavailable")
		return
	}
	http.SetCookie(w, cookie)
	http.Redirect(w, r, target, http.StatusSeeOther)
}

// StarCallback issues the ordinary Multica session for an explicitly linked
// existing user. It neither creates memberships nor changes any role.
func (h *Handler) StarCallback(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if h.StarOIDC == nil {
		writeError(w, http.StatusServiceUnavailable, "star sign-in is unavailable")
		return
	}
	http.SetCookie(w, h.StarOIDC.ClearCookie())
	identity, err := h.StarOIDC.Finish(r.Context(), r)
	if err != nil {
		// A verified but unlinked account must not retain an older user session.
		if errors.Is(err, auth.ErrStarUnlinked) {
			auth.ClearAuthCookies(w)
			http.Redirect(w, r, "/login?star_error=unlinked", http.StatusSeeOther)
			return
		}
		writeError(w, http.StatusUnauthorized, "star account is not verified or not linked; contact your administrator")
		return
	}
	id, ok := parseUUIDOrBadRequest(w, identity.UserID, "linked user")
	if !ok {
		return
	}
	user, err := h.Queries.GetUser(r.Context(), id)
	if err != nil {
		auth.ClearAuthCookies(w)
		http.Redirect(w, r, "/login?star_error=unlinked", http.StatusSeeOther)
		return
	}
	token, err := h.issueJWT(user)
	if err != nil {
		auth.ClearAuthCookies(w)
		http.Redirect(w, r, "/login?star_error=unlinked", http.StatusSeeOther)
		return
	}
	next := identity.Next
	if identity.Destination == "openclaw" {
		if !auth.IsStarLocalRequest(r) {
			auth.ClearAuthCookies(w)
			writeError(w, http.StatusForbidden, "local dashboard sign-in is available only on this Mac")
			return
		}
		next, err = h.StarOIDC.OpenLocalDashboard(r.Context(), identity)
		if err != nil {
			auth.ClearAuthCookies(w)
			status := http.StatusServiceUnavailable
			if errors.Is(err, auth.ErrStarDashboardOwner) {
				status = http.StatusForbidden
			}
			writeError(w, status, "local dashboard could not be opened for this account")
			return
		}
	}
	if err = auth.SetAuthCookies(w, token); err != nil {
		writeError(w, http.StatusServiceUnavailable, "session could not be established")
		return
	}
	http.Redirect(w, r, next, http.StatusSeeOther)
}
