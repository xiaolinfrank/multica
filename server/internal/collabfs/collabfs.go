// Package collabfs performs the filesystem half of the collaboration space:
// every operation is anchored on a configured root, walks down one component at
// a time with O_NOFOLLOW, and refuses anything that would escape the root or
// change identity underneath it (a swapped folder, a symlink planted in the
// middle, a file where a directory is expected).
//
// It is deliberately stateless. The collaboration space is a real NAS tree that
// agents and people also write to, so there is no ledger here to fall out of
// step with the disk: a folder either exists, or it does not, and the caller
// asks again.
package collabfs

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/text/unicode/norm"

	"github.com/multica-ai/multica/server/internal/localpaths"
)

var (
	// ErrDirectoryChanged means the path is a symlink, a non-directory, or a
	// different directory than the one this call opened earlier.
	ErrDirectoryChanged = errors.New("directory changed or contains an unsafe filesystem entry")
	// ErrOutsideRoot means the resolved path would leave its configured root.
	ErrOutsideRoot = errors.New("path would fall outside its configured root")
	// ErrRootUnavailable means the configured root cannot be opened as a
	// directory on this server right now.
	ErrRootUnavailable = errors.New("collaboration space root is unavailable")
	// ErrTargetExists means a rename or move would land on an existing entry.
	// Nothing is overwritten; the caller keeps its current folder name.
	ErrTargetExists = errors.New("target directory already exists")
	// ErrSourceMissing means there is nothing to move.
	ErrSourceMissing = errors.New("source directory does not exist")
)

// Root is an opened, identity-pinned collaboration space root. It stays valid
// for the duration of one request and must be closed.
type Root struct {
	original, canonical string
	file                *os.File
	identity            os.FileInfo
	opened              []*os.File
}

// Dir is an opened directory inside a Root. It keeps a handle so a rename or
// replacement of the path can be detected instead of silently written through.
type Dir struct {
	root     *Root
	parent   *Dir
	file     *os.File
	name     string
	path     string
	identity os.FileInfo
}

// OpenRoot resolves a configured root. Ancestor platform aliases (a macOS
// `/Volumes` mount, for instance) may resolve to a real path, but the final
// configured component itself must be a real directory, not a link.
func OpenRoot(root string) (*Root, error) {
	root = filepath.Clean(strings.TrimSpace(root))
	if !filepath.IsAbs(root) {
		return nil, fmt.Errorf("%w: %q is not an absolute path on this server", ErrRootUnavailable, root)
	}
	initial, err := os.Lstat(root)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrRootUnavailable, err)
	}
	if !initial.IsDir() || initial.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("%w: %q is not a real directory", ErrRootUnavailable, root)
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(root))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrRootUnavailable, err)
	}
	canonical := filepath.Join(parent, filepath.Base(root))
	file, err := openPath(canonical)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrRootUnavailable, err)
	}
	held, err := file.Stat()
	if err != nil || !os.SameFile(initial, held) {
		_ = file.Close()
		return nil, ErrDirectoryChanged
	}
	r := &Root{original: root, canonical: canonical, file: file, identity: held, opened: []*os.File{file}}
	if err := r.Verify(); err != nil {
		r.Close()
		return nil, err
	}
	return r, nil
}

// Close releases every handle opened through this root.
func (r *Root) Close() {
	for i := len(r.opened) - 1; i >= 0; i-- {
		_ = r.opened[i].Close()
	}
}

// Path is the root as configured (its pinned canonical location may differ).
func (r *Root) Path() string { return r.original }

// File exposes the held directory handle for callers that read entries.
func (r *Root) File() *os.File { return r.file }

// Verify re-checks that both the configured and canonical paths still name the
// directory this root opened.
func (r *Root) Verify() error {
	for _, path := range []string{r.original, r.canonical} {
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !os.SameFile(info, r.identity) {
			return ErrDirectoryChanged
		}
	}
	held, err := r.file.Stat()
	if err != nil || !os.SameFile(held, r.identity) {
		return ErrDirectoryChanged
	}
	return nil
}

// Verify re-checks this directory and its whole parent chain.
func (d *Dir) Verify() error {
	if err := d.root.Verify(); err != nil {
		return err
	}
	if d.parent == nil {
		return nil
	}
	if err := d.parent.Verify(); err != nil {
		return err
	}
	peer, err := openChild(d.parent.file, d.name, false)
	if err != nil {
		return ErrDirectoryChanged
	}
	defer peer.Close()
	info, err := peer.Stat()
	if err != nil || !os.SameFile(info, d.identity) {
		return ErrDirectoryChanged
	}
	return nil
}

// Path is the absolute path this directory was opened at.
func (d *Dir) Path() string { return d.path }

// File exposes the held handle.
func (d *Dir) File() *os.File { return d.file }

// Info is the identity this handle was opened with (mode bits and mtime).
func (d *Dir) Info() os.FileInfo { return d.identity }

// Close releases this directory's handle.
func (d *Dir) Close() error { return d.file.Close() }

// Child opens (and optionally creates) one direct child directory.
func (d *Dir) Child(name string, create bool) (*Dir, error) {
	if !validSegment(name) {
		return nil, ErrDirectoryChanged
	}
	if err := d.Verify(); err != nil {
		return nil, err
	}
	file, err := openChild(d.file, name, create)
	if err != nil {
		return nil, err
	}
	d.root.opened = append(d.root.opened, file)
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	child := &Dir{root: d.root, parent: d, file: file, name: name, path: filepath.Join(d.path, name), identity: info}
	if err := child.Verify(); err != nil {
		_ = file.Close()
		return nil, err
	}
	return child, nil
}

// Directory opens a directory by path. The path must stay inside the root; each
// component is opened in turn, and creation only ever makes directories.
func (r *Root) Directory(path string, create bool) (*Dir, error) {
	rel, err := filepath.Rel(r.original, filepath.Clean(path))
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
		return nil, ErrOutsideRoot
	}
	dir := &Dir{root: r, file: r.file, path: r.original, identity: r.identity}
	if rel == "." {
		return dir, dir.Verify()
	}
	for _, name := range strings.Split(rel, string(os.PathSeparator)) {
		dir, err = dir.Child(name, create)
		if err != nil {
			return nil, err
		}
	}
	return dir, dir.Verify()
}

// Directory opens the directory named by segments below this one, creating
// missing levels when create is set.
func (d *Dir) Directory(segments []string, create bool) (*Dir, error) {
	dir := d
	var err error
	for _, name := range segments {
		if name == "" {
			continue
		}
		if !validSegment(name) {
			return nil, fmt.Errorf("%w: %q is not a single safe folder name", ErrDirectoryChanged, name)
		}
		dir, err = dir.Child(name, create)
		if err != nil {
			return nil, err
		}
	}
	return dir, nil
}

// Entries lists visible child directories, sorted. Hidden entries and anything
// that is not a directory (a symlink included) are skipped.
func (d *Dir) Entries(ctx context.Context, limit int) ([]string, bool, error) {
	var entries []string
	truncated := false
	for {
		if err := ctx.Err(); err != nil {
			return nil, false, err
		}
		batch, err := d.file.Readdirnames(128)
		for _, name := range batch {
			if strings.HasPrefix(name, ".") {
				continue
			}
			child, openErr := openChild(d.file, name, false)
			if openErr != nil {
				if errors.Is(openErr, ErrDirectoryChanged) || os.IsNotExist(openErr) {
					continue
				}
				return nil, false, openErr
			}
			_ = child.Close()
			if len(entries) == limit {
				truncated = true
				break
			}
			entries = append(entries, name)
		}
		if truncated || errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, false, err
		}
	}
	if err := d.Verify(); err != nil {
		return nil, false, err
	}
	sort.Strings(entries)
	return entries, truncated, nil
}

// VisibleCount counts non-hidden entries without opening them.
func (d *Dir) VisibleCount(ctx context.Context) (int, error) {
	count := 0
	for {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		batch, err := d.file.Readdirnames(128)
		for _, name := range batch {
			if !strings.HasPrefix(name, ".") {
				count++
			}
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return 0, err
		}
	}
	return count, d.Verify()
}

func validSegment(name string) bool {
	return name != "" && name != "." && name != ".." && filepath.Base(name) == name && !strings.ContainsAny(name, `/\`) && !strings.ContainsRune(name, 0)
}

// NormalizeForMatch compares folder names as people read them: whitespace is
// insignificant, so "04.01 确权线" and "04.01确权线" are the same folder.
func NormalizeForMatch(s string) string {
	return strings.Map(func(r rune) rune {
		if r == ' ' || r == '\t' || r == '\u3000' || r == '\u00a0' {
			return -1
		}
		return r
	}, s)
}

// SanitizeFolderName turns arbitrary text into one safe path component: NFC
// normalised, characters a filesystem refuses replaced with "-", surrounding
// spaces and dots trimmed, and the result cut to maxRunes (0 = no rune limit,
// the 240-byte cap still applies).
func SanitizeFolderName(raw string, maxRunes int) string {
	s := strings.Map(func(r rune) rune {
		if r == 0 || isDisallowedRune(r) {
			return '-'
		}
		return r
	}, norm.NFC.String(raw))
	s = strings.Trim(s, " .")
	runes := []rune(s)
	if maxRunes > 0 && len(runes) > maxRunes {
		runes = runes[:maxRunes]
	}
	// The 240 limit is a byte check in ValidFolder; a CJK name hits it at 80
	// characters, so cut further rather than hand back a name the API rejects.
	for len(runes) > 0 && len(string(runes)) > 240 {
		runes = runes[:len(runes)-1]
	}
	return strings.TrimRight(string(runes), " .")
}

func isDisallowedRune(r rune) bool {
	if r < 0x20 || r == 0x7f {
		return true
	}
	return strings.ContainsRune(`/\:`, r)
}

// UniqueName picks a folder name no sibling uses, ignoring case: "Confirm",
// then "Confirm(2)", "Confirm(3)"… `taken` answers for the caller's own
// namespace (the disk for a create, the database for a rename).
func UniqueName(base string, taken func(string) bool) string {
	if base == "" {
		base = "未命名"
	}
	candidate := TruncateForSuffix(base, "")
	if !taken(candidate) {
		return candidate
	}
	for n := 2; n < 1000; n++ {
		suffix := fmt.Sprintf("(%d)", n)
		candidate = TruncateForSuffix(base, suffix) + suffix
		if !taken(candidate) {
			return candidate
		}
	}
	return candidate
}

// TruncateForSuffix shortens a name so that appending suffix keeps it inside
// the byte limit ValidFolder enforces.
func TruncateForSuffix(base, suffix string) string {
	max := 240 - len(suffix)
	if len(base) <= max {
		return base
	}
	runes := []rune(base)
	for len(runes) > 0 && len(string(runes)) > max {
		runes = runes[:len(runes)-1]
	}
	return string(runes)
}

// EnsureDir creates root/rel... if it does not exist yet. Existing directories
// are a success; a symlink, a file in the way, or a path outside the root is
// refused with a specific error.
func EnsureDir(root string, rel ...string) error {
	r, err := OpenRoot(root)
	if err != nil {
		return err
	}
	defer r.Close()
	_, err = r.Directory(filepath.Join(append([]string{root}, rel...)...), true)
	return err
}

// StatCode classifies a directory without creating anything.
type StatCode string

const (
	StatOK      StatCode = "ok"
	StatMissing StatCode = "missing"
	StatInvalid StatCode = "invalid"
	StatNoRoot  StatCode = "root_unavailable"
)

// StatDir reports whether root/rel... exists as a real directory.
func StatDir(root string, rel ...string) (StatCode, error) {
	r, err := OpenRoot(root)
	if err != nil {
		return StatNoRoot, err
	}
	defer r.Close()
	dir, err := r.Directory(filepath.Join(append([]string{root}, rel...)...), false)
	if err == nil {
		if err := dir.Verify(); err != nil {
			return StatInvalid, err
		}
		return StatOK, nil
	}
	if os.IsNotExist(err) {
		return StatMissing, nil
	}
	if errors.Is(err, ErrDirectoryChanged) || errors.Is(err, ErrOutsideRoot) {
		return StatInvalid, err
	}
	return StatInvalid, err
}

// RenameOrMove moves srcRoot/srcRel to dstRoot/dstRel.
//
//   - source missing            → ErrSourceMissing (caller keeps the DB name)
//   - same path                 → nil
//   - destination exists        → ErrTargetExists, nothing overwritten
//   - one filesystem            → atomic rename
//   - across mount points       → copy (refusing symlinks) then remove
//
// Missing parents of the destination are created.
func RenameOrMove(srcRoot string, srcRel []string, dstRoot string, dstRel []string) error {
	srcPath := filepath.Join(append([]string{srcRoot}, srcRel...)...)
	dstPath := filepath.Join(append([]string{dstRoot}, dstRel...)...)
	if filepath.Clean(srcPath) == filepath.Clean(dstPath) {
		return nil
	}

	src, err := OpenRoot(srcRoot)
	if err != nil {
		return err
	}
	defer src.Close()
	srcDir, err := src.Directory(srcPath, false)
	if err != nil {
		if os.IsNotExist(err) {
			return ErrSourceMissing
		}
		return err
	}

	dst, err := OpenRoot(dstRoot)
	if err != nil {
		return err
	}
	defer dst.Close()
	dstParent := filepath.Dir(dstPath)
	if _, err := dst.Directory(dstParent, true); err != nil {
		return err
	}
	if _, err := os.Lstat(dstPath); err == nil {
		// Anything at the destination — a directory, a file, a link — is a
		// collision. Overwriting is never this call's decision.
		return ErrTargetExists
	} else if !os.IsNotExist(err) {
		return err
	}

	if err := os.Rename(srcDir.Path(), dstPath); err == nil {
		return nil
	} else if !isCrossDevice(err) {
		return err
	}
	if err := copyTree(srcDir.Path(), dstPath); err != nil {
		_ = os.RemoveAll(dstPath)
		return err
	}
	if err := removeTree(srcDir.Path()); err != nil {
		return fmt.Errorf("moved by copy but could not clear the source: %w", err)
	}
	return nil
}

// DeliveryPath composes the fixed delivery folder for an issue:
//
//	<collab>/<module>/<work item>/<issue>   with a work item
//	<collab>/<module>/<issue>               without one
//	<collab>/<issue>                        without a module
//
// Empty when the project has no collaboration space, or the issue has no folder
// name yet — the caller decides whether that is "not allocated" or "nothing to
// show". Every segment is validated, so a hand-edited name cannot smuggle a
// path separator into the result.
func DeliveryPath(collabPath string, moduleDir, workItemDir, issueDir *string) (string, error) {
	collab := strings.TrimSpace(collabPath)
	if collab == "" || issueDir == nil || *issueDir == "" {
		return "", nil
	}
	segments := []string{collab}
	for _, segment := range []*string{moduleDir, workItemDir, issueDir} {
		if segment == nil || *segment == "" {
			continue
		}
		if !localpaths.ValidFolder(*segment) {
			return "", fmt.Errorf("%q is not a single safe folder name", *segment)
		}
		segments = append(segments, *segment)
	}
	return filepath.Join(segments...), nil
}
