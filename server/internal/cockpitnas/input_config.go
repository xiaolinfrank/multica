package cockpitnas

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

func validInputRelative(path string) bool {
	if path == "" || len(path) > 4096 || !utf8.ValidString(path) || filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsAny(path, "\\\x00") || strings.IndexFunc(path, unicode.IsControl) >= 0 {
		return false
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == ".." || (part == "." && path != ".") || len(part) > 255 {
			return false
		}
	}
	return true
}
func normalizeInputSubpaths(root *Root) error {
	if len(root.InputSubpaths) > 32 {
		return fmt.Errorf("NAS input access allows at most 32 explicit subpaths")
	}
	seen := map[string]bool{}
	for _, path := range root.InputSubpaths {
		if !validInputRelative(path) || inputProtectedPath(path, true) || seen[path] {
			return fmt.Errorf("NAS input_subpaths must contain unique canonical relative paths")
		}
		seen[path] = true
	}
	sort.Strings(root.InputSubpaths)
	return nil
}
func (f *Files) inputRoot(workspace, rootID, relative string) (Root, string, error) {
	if f == nil {
		return Root{}, "", fail("input_scope_not_configured", "NAS input access has not been configured for this workspace.", false)
	}
	root, ok := f.roots[workspace]
	if !ok || len(root.InputSubpaths) == 0 {
		return Root{}, "", fail("input_scope_not_configured", "NAS input access has not been configured for this workspace.", false)
	}
	if root.RootID != rootID || !validInputRelative(relative) || inputProtectedPath(relative, true) || inputProtectedPath(root.Path, false) {
		return Root{}, "", fail("input_path_outside_scope", "Choose a path in an explicitly authorized input scope.", false)
	}
	allowed := false
	for _, scope := range root.InputSubpaths {
		if contains(filepath.Join(root.Path, scope), filepath.Join(root.Path, relative)) {
			allowed = true
			break
		}
	}
	if !allowed {
		return Root{}, "", fail("input_path_outside_scope", "This path is outside the deployment's input scopes.", false)
	}
	hash := preparationHash([]any{root.WorkspaceID, root.RootID, root.Path, root.AllowLocal, root.InputSubpaths})
	return root, hash, nil
}
