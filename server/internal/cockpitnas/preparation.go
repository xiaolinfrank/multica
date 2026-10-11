package cockpitnas

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

type PreparationRoot struct {
	RootID   string
	Path     string
	Subpaths []string
}

type PreparationTarget struct {
	WorkspaceID, RootID, RootPath, PrepareSubpath            string
	RelativeDirectory, Directory, TargetHash, RootConfigHash string
}

type PreparationObservation struct {
	Directory, DirectoryIdentity, RootIdentity, Outcome, ObservedAt string
}

type PreparationInspection struct {
	RelativePath, State, ErrorCode string
}

// Preparation is a distinct deployment capability; export permission never
// enables directory creation or filesystem browsing.
type Preparation interface {
	PreparationRoot(string) (*PreparationRoot, error)
	ResolvePreparation(string, string, string) (PreparationTarget, error)
	InspectPreparation(context.Context, PreparationTarget, []string) ([]PreparationInspection, error)
	EnsurePreparedDirectory(context.Context, PreparationTarget, string) (PreparationObservation, error)
}

func (f *Files) acquirePreparation(ctx context.Context) (func(), error) {
	if f == nil || f.preparationSlots == nil {
		return nil, fail("prepare_not_configured", "Directory preparation is not configured.", false)
	}
	select {
	case f.preparationSlots <- struct{}{}:
		return func() { <-f.preparationSlots }, nil
	case <-ctx.Done():
		return nil, fail("io_timeout", "Directory preparation is waiting for an available bounded filesystem worker.", true)
	}
}

func validPreparationRelative(v string) bool {
	if v == "" || len(v) > 4096 || !utf8.ValidString(v) || filepath.IsAbs(v) || strings.ContainsAny(v, "\\\x00") || strings.IndexFunc(v, unicode.IsControl) >= 0 || filepath.Clean(v) != v {
		return false
	}
	parts := strings.Split(v, "/")
	if len(parts) > 16 {
		return false
	}
	for _, part := range parts {
		if part == "" || part == ".." || (part == "." && v != ".") || len(part) > 255 {
			return false
		}
	}
	return true
}

func normalizePrepareSubpaths(root *Root) error {
	if len(root.PrepareSubpaths) > 32 {
		return fmt.Errorf("NAS preparation allows at most 32 explicit subpaths")
	}
	seen := map[string]bool{}
	for _, p := range root.PrepareSubpaths {
		if !validPreparationRelative(p) || seen[p] {
			return fmt.Errorf("NAS prepare_subpaths must contain unique canonical relative directories")
		}
		seen[p] = true
	}
	sort.Strings(root.PrepareSubpaths)
	return nil
}

func preparationHash(v any) string {
	b, _ := json.Marshal(v)
	return fmt.Sprintf("%x", sha256.Sum256(b))
}

func (f *Files) PreparationRoot(workspace string) (*PreparationRoot, error) {
	if f == nil {
		return nil, fail("prepare_not_configured", "Directory preparation has not been configured for this workspace.", false)
	}
	r, ok := f.roots[workspace]
	if !ok || len(r.PrepareSubpaths) == 0 {
		return nil, fail("prepare_not_configured", "Directory preparation has not been configured for this workspace.", false)
	}
	return &PreparationRoot{RootID: r.RootID, Path: r.Path, Subpaths: append([]string{}, r.PrepareSubpaths...)}, nil
}

func (f *Files) ResolvePreparation(workspace, rootID, relative string) (PreparationTarget, error) {
	var empty PreparationTarget
	if _, err := f.PreparationRoot(workspace); err != nil {
		return empty, err
	}
	r := f.roots[workspace]
	if rootID != r.RootID || !validPreparationRelative(relative) {
		return empty, fail("prepare_path_outside_scope", "Choose a directory within an explicitly authorized preparation scope.", false)
	}
	if !platformSupported {
		return empty, fail("unsupported_storage", "Directory preparation is unsupported on this server platform.", false)
	}
	directory := filepath.Join(r.Path, relative)
	scope := ""
	for _, candidate := range r.PrepareSubpaths {
		if contains(filepath.Join(r.Path, candidate), directory) && (scope == "" || len(candidate) > len(scope)) {
			scope = candidate
		}
	}
	if scope == "" {
		return empty, fail("prepare_path_outside_scope", "This directory is outside the deployment's authorized preparation scopes.", false)
	}
	return PreparationTarget{WorkspaceID: workspace, RootID: r.RootID, RootPath: r.Path, PrepareSubpath: scope, RelativeDirectory: relative, Directory: directory,
		TargetHash: preparationHash([]string{r.RootID, relative}), RootConfigHash: preparationHash([]any{r.WorkspaceID, r.RootID, r.Path, r.AllowLocal, r.PrepareSubpaths})}, nil
}

func (f *Files) validatePreparation(t PreparationTarget, relative string) (Root, error) {
	current, err := f.ResolvePreparation(t.WorkspaceID, t.RootID, t.RelativeDirectory)
	if err != nil {
		return Root{}, err
	}
	if current != t {
		return Root{}, fail("root_config_changed", "The configured preparation scope changed; recheck the original target.", false)
	}
	if !validPreparationRelative(relative) {
		return Root{}, fail("prepare_path_outside_scope", "The directory step has an invalid relative path.", false)
	}
	p := filepath.Join(t.RootPath, relative)
	// Reject a path before touching the filesystem if its complete observation
	// cannot fit the immutable receipt budget (JSON escaping can expand it).
	bound, _ := json.Marshal(PreparationObservation{Directory: p, DirectoryIdentity: strings.Repeat("x", 80), RootIdentity: strings.Repeat("x", 80), Outcome: "observed_existing", ObservedAt: strings.Repeat("x", 40)})
	if len(bound) > 16000 {
		return Root{}, fail("invalid_input", "The complete directory observation exceeds its supported size.", false)
	}

	boundary := filepath.Join(t.RootPath, t.PrepareSubpath)
	if !contains(boundary, p) || (!contains(p, t.Directory) && !contains(t.Directory, p)) {
		return Root{}, fail("prepare_path_outside_scope", "The directory step does not belong to this fixed target.", false)
	}
	return f.roots[t.WorkspaceID], nil
}
