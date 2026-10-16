package handler

import (
	"errors"
	"net/http"

	"github.com/multica-ai/multica/server/internal/auth"
)

// StarSignIn delegates authentication to the configured star account provider.
func (h *Handler) StarSignIn(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if h.StarOIDC == nil {
		writeError(w, http.StatusServiceUnavailable, "star sign-in is not configured or unavailable")
		return
	}
	target, cookie, err := h.StarOIDC.Begin(r.URL.Query().Get("next"))
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
	userID, next, err := h.StarOIDC.Finish(r.Context(), r)
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
	id, ok := parseUUIDOrBadRequest(w, userID, "linked user")
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
	if err = auth.SetAuthCookies(w, token); err != nil {
		writeError(w, http.StatusServiceUnavailable, "session could not be established")
		return
	}
	http.Redirect(w, r, next, http.StatusSeeOther)
}
