package cockpitnas

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"

	"github.com/google/uuid"
)

const MarkerName = ".multica-root-id"
const PublishedDirectory = "已发布纪要"
const MaxContentBytes = 128 * 1024

type Directory struct {
	RootID    string `json:"root_id"`
	Directory string `json:"directory"`
}

type Destination struct {
	RootID, RootPath, Directory, RelativePath, TargetPath string
}

type Request struct {
	WorkspaceID, VersionID, OperationID, LeaseToken, Content, ContentHash string
	Destination                                                           Destination
}

type Result struct {
	Path, ContentHash string
	Size              int64
}

type Exporter interface {
	RootIDs() []string
	Preview(workspaceID, directory string) (Directory, error)
	Resolve(workspaceID, directory, versionID string, versionNumber int32) (Destination, error)
	Write(context.Context, Request) (Result, error)
}

type Error struct {
	Code, Message string
	Retryable     bool
}

func (e *Error) Error() string { return e.Message }

func fail(code, message string, retryable bool) error {
	return &Error{Code: code, Message: message, Retryable: retryable}
}

// Root authorizes one workspace subtree on this server. The marker must be
// provisioned by its operator; a request never creates a root or its identity.
type Root struct {
	WorkspaceID string `json:"workspace_id"`
	RootID      string `json:"root_id"`
	Path        string `json:"path"`
	AllowLocal  bool   `json:"allow_local,omitempty"`
}

type Files struct {
	roots map[string]Root
	// Package-private fault injection; never configured by an API or runtime.
	beforeCommit  func()
	beforeAck     func()
	syncDirectory func(*os.File) error
}

func New(raw string) (*Files, error) {
	f := &Files{roots: make(map[string]Root)}
	if strings.TrimSpace(raw) == "" {
		return f, nil
	}
	var roots []Root
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&roots); err != nil {
		return nil, fmt.Errorf("invalid COCKPIT_NAS_EXPORT_ROOTS JSON")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, fmt.Errorf("NAS root configuration must contain one JSON array")
	}
	seen := make(map[string]bool)
	for _, root := range roots {
		ws, err := uuid.Parse(root.WorkspaceID)
		if err != nil || ws == uuid.Nil {
			return nil, fmt.Errorf("NAS root workspace_id must be a UUID")
		}
		id, err := uuid.Parse(root.RootID)
		if err != nil || id == uuid.Nil {
			return nil, fmt.Errorf("NAS root root_id must be a UUID")
		}
		root.WorkspaceID, root.RootID = ws.String(), id.String()
		if !validAbsolutePath(root.Path) || root.Path == string(filepath.Separator) {
			return nil, fmt.Errorf("NAS root requires an explicit absolute subtree")
		}
		root.Path = filepath.Clean(root.Path)
		if _, exists := f.roots[root.WorkspaceID]; exists || seen[root.RootID] {
			return nil, fmt.Errorf("NAS roots require unique workspace and root identities")
		}
		for _, existing := range f.roots {
			if contains(existing.Path, root.Path) || contains(root.Path, existing.Path) {
				return nil, fmt.Errorf("workspace NAS roots must not overlap")
			}
		}
		seen[root.RootID] = true
		f.roots[root.WorkspaceID] = root
	}
	return f, nil
}

func validAbsolutePath(path string) bool {
	if path == "" || len(path) > 4096 || !filepath.IsAbs(path) || strings.TrimSpace(path) != path {
		return false
	}
	for _, c := range path {
		if unicode.IsControl(c) {
			return false
		}
	}
	for _, part := range strings.Split(path, string(filepath.Separator)) {
		if part == "." || part == ".." {
			return false
		}
	}
	return true
}

func contains(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func (f *Files) RootIDs() []string {
	ids := make([]string, 0, len(f.roots))
	for _, root := range f.roots {
		ids = append(ids, root.RootID)
	}
	sort.Strings(ids)
	return ids
}

func (f *Files) Preview(workspaceID, directory string) (Directory, error) {
	root, exists := f.roots[workspaceID]
	if !exists {
		return Directory{}, fail("not_configured", "No NAS export root is configured for this workspace.", false)
	}
	if !platformSupported {
		return Directory{}, fail("unsupported_platform", "NAS export is not supported on this server platform.", false)
	}
	if directory == "" {
		return Directory{}, fail("directory_missing", "Choose the meeting material directory before exporting.", false)
	}
	if !validAbsolutePath(directory) || !contains(root.Path, directory) {
		return Directory{}, fail("outside_root", "The meeting directory is outside its authorized NAS root.", false)
	}
	return Directory{RootID: root.RootID, Directory: filepath.Clean(directory)}, nil
}

func (f *Files) Resolve(workspaceID, directory, versionID string, versionNumber int32) (Destination, error) {
	preview, err := f.Preview(workspaceID, directory)
	if err != nil {
		return Destination{}, err
	}
	id, err := uuid.Parse(versionID)
	if err != nil || id == uuid.Nil || versionNumber < 1 {
		return Destination{}, fail("invalid_version", "A fixed minutes version is required.", false)
	}
	root := f.roots[workspaceID]
	name := fmt.Sprintf("minutes-v%04d-%s.md", versionNumber, id.String())
	target := filepath.Join(preview.Directory, PublishedDirectory, name)
	rel, _ := filepath.Rel(root.Path, target)
	return Destination{RootID: root.RootID, RootPath: root.Path, Directory: preview.Directory, RelativePath: rel, TargetPath: target}, nil
}

func (f *Files) validate(request Request) (Root, error) {
	root, exists := f.roots[request.WorkspaceID]
	d := request.Destination
	if !exists || root.RootID != d.RootID || root.Path != d.RootPath {
		return Root{}, fail("root_changed", "The configured export root changed; the original destination is retained.", false)
	}
	if _, err := f.Preview(request.WorkspaceID, d.Directory); err != nil {
		return Root{}, err
	}
	if !contains(root.Path, d.TargetPath) || filepath.Join(root.Path, d.RelativePath) != d.TargetPath ||
		filepath.Dir(d.TargetPath) != filepath.Join(d.Directory, PublishedDirectory) {
		return Root{}, fail("invalid_destination", "The export destination does not match its fixed directory.", false)
	}
	for _, id := range []string{request.VersionID, request.OperationID, request.LeaseToken} {
		value, err := uuid.Parse(id)
		if err != nil || value == uuid.Nil || value.String() != id {
			return Root{}, fail("invalid_identity", "The export identity is invalid.", false)
		}
	}
	name := filepath.Base(d.TargetPath)
	if !strings.HasPrefix(name, "minutes-v") || !strings.HasSuffix(name, "-"+request.VersionID+".md") {
		return Root{}, fail("invalid_destination", "The filename does not identify this version.", false)
	}
	if len(request.Content) == 0 || len(request.Content) > MaxContentBytes || fmt.Sprintf("%x", sha256.Sum256([]byte(request.Content))) != request.ContentHash {
		return Root{}, fail("content_mismatch", "The stored minutes content does not match its fingerprint.", false)
	}
	return root, nil
}
