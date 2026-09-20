package handler

import (
	"fmt"
	"net/http"
	"strings"
	"unicode"

	"github.com/jackc/pgx/v5/pgtype"
)

// collabPathMaxLen bounds the stored path. Deep NAS trees are legitimate, but a
// value this long is a paste accident, not a directory.
const collabPathMaxLen = 1024

// normalizeCollabPath validates and trims a human-agent collaboration space
// path ("人机协作空间路径"): the directory on shared storage where a project
// exchanges deliverables between people and agents. Only a project stores one —
// a module's folder sits inside it under the module's own name.
//
// The server never stats the path. It is resolved on whichever daemon host
// runs the task, and a host that has not mounted the share must fail loudly at
// the agent rather than have the platform reject a value that is correct
// everywhere else. So validation only rejects values that cannot be a path on
// any host: relative paths (which would silently resolve inside a task's
// private workdir — the one place a deliverable must not land), control
// characters, and absurd lengths.
//
// A blank value after trimming means "no path", which callers store as NULL.
func normalizeCollabPath(raw string) (pgtype.Text, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return pgtype.Text{Valid: false}, nil
	}
	if len(trimmed) > collabPathMaxLen {
		return pgtype.Text{}, fmt.Errorf("collab_path must be at most %d characters", collabPathMaxLen)
	}
	for _, r := range trimmed {
		if r == '\x00' || (unicode.IsControl(r) && r != '\t') {
			return pgtype.Text{}, fmt.Errorf("collab_path must not contain control characters")
		}
	}
	if !isAbsoluteCollabPath(trimmed) {
		return pgtype.Text{}, fmt.Errorf("collab_path must be an absolute path (for example /Volumes/人机协作空间/项目/模块)")
	}
	return pgtype.Text{String: trimmed, Valid: true}, nil
}

// isAbsoluteCollabPath accepts the absolute forms a daemon host can mount:
// POSIX ("/Volumes/..."), Windows drive ("Z:\..." or "Z:/...") and UNC
// ("\\nas\share\..."). Daemons run on macOS, Linux and Windows, so pinning the
// check to one separator would reject a correct value on the other platforms.
func isAbsoluteCollabPath(p string) bool {
	if strings.HasPrefix(p, "/") || strings.HasPrefix(p, `\\`) {
		return true
	}
	if len(p) >= 3 && p[1] == ':' && (p[2] == '/' || p[2] == '\\') {
		c := p[0]
		return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
	}
	return false
}

// collabPathFromRequest resolves an optional request field into column state,
// writing a 400 and returning ok=false when the value is unusable. A nil
// pointer clears the column, matching the "present key, null value" contract
// the project and module update handlers use for every other nullable field.
func collabPathFromRequest(w http.ResponseWriter, value *string) (pgtype.Text, bool) {
	if value == nil {
		return pgtype.Text{Valid: false}, true
	}
	normalized, err := normalizeCollabPath(*value)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return pgtype.Text{}, false
	}
	return normalized, true
}
