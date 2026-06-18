// Package seed provides the default workspace bootstrap: a curated team of
// biomedical-intelligence agents and squads that is created automatically the
// first time a workspace brings a runtime online. The agent portraits are
// embedded here so the avatars are self-contained in the binary and resolve to
// a stable URL regardless of the storage backend (S3 / local / none).
package seed

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed avatars/*.png
var avatarFS embed.FS

// AvatarRoutePrefix is the public URL prefix under which default agent avatars
// are served. It deliberately lives under /uploads/ so the web app's existing
// same-origin proxy (next.config rewrites `/uploads/:path*`) reaches it with no
// extra configuration, and so a more specific chi route shadows the generic
// LocalStorage `/uploads/*` handler.
const AvatarRoutePrefix = "/uploads/agent-avatars/"

// AvatarURLFor returns the stable avatar_url for an avatar slug, e.g.
// "research-lead" -> "/uploads/agent-avatars/research-lead.png". The frontend
// treats a leading-slash value as site-relative and joins it onto the API base.
func AvatarURLFor(slug string) string {
	return AvatarRoutePrefix + slug + ".png"
}

// HasAvatar reports whether an embedded avatar exists for the slug. Used by the
// template validator to fail loudly at startup on a typo'd reference.
func HasAvatar(slug string) bool {
	_, err := fs.Stat(avatarFS, "avatars/"+slug+".png")
	return err == nil
}

// ServeAvatar serves an embedded default agent avatar PNG. Mount it at
// AvatarRoutePrefix on a public (no-auth) route. Only a flat "<slug>.png" file
// name is accepted; anything with a path separator or non-png suffix 404s,
// which also defends against traversal.
func ServeAvatar(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, AvatarRoutePrefix)
	if name == "" || strings.ContainsAny(name, "/\\") || !strings.HasSuffix(name, ".png") {
		http.NotFound(w, r)
		return
	}
	data, err := avatarFS.ReadFile("avatars/" + name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(data)
}
