package handler

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var errMeetingDirectoryChanged = errors.New("meeting directory changed or contains an unsafe filesystem entry")

type meetingArchiveRoot struct {
	original, canonical string
	file                *os.File
	identity            os.FileInfo
	opened              []*os.File
}
type meetingArchiveDirectory struct {
	root     *meetingArchiveRoot
	parent   *meetingArchiveDirectory
	file     *os.File
	name     string
	path     string
	identity os.FileInfo
}

// Ancestor platform aliases may resolve to a real root. The final configured
// root itself must not be a link, and its identity stays pinned for this call.
func openMeetingArchive(root string) (*meetingArchiveRoot, error) {
	root = filepath.Clean(strings.TrimSpace(root))
	if !filepath.IsAbs(root) {
		return nil, errors.New("meeting folder root is not an absolute path on this server")
	}
	initial, err := os.Lstat(root)
	if err != nil {
		return nil, fmt.Errorf("meeting folder root is unavailable: %w", err)
	}
	if !initial.IsDir() || initial.Mode()&os.ModeSymlink != 0 {
		return nil, errMeetingDirectoryChanged
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(root))
	if err != nil {
		return nil, err
	}
	canonical := filepath.Join(parent, filepath.Base(root))
	file, err := openMeetingDirectoryPath(canonical)
	if err != nil {
		return nil, err
	}
	held, err := file.Stat()
	if err != nil || !os.SameFile(initial, held) {
		_ = file.Close()
		return nil, errMeetingDirectoryChanged
	}
	a := &meetingArchiveRoot{original: root, canonical: canonical, file: file, identity: held, opened: []*os.File{file}}
	if err := a.verify(); err != nil {
		a.close()
		return nil, err
	}
	return a, nil
}
func (a *meetingArchiveRoot) close() {
	for i := len(a.opened) - 1; i >= 0; i-- {
		_ = a.opened[i].Close()
	}
}
func (a *meetingArchiveRoot) verify() error {
	for _, path := range []string{a.original, a.canonical} {
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !os.SameFile(info, a.identity) {
			return errMeetingDirectoryChanged
		}
	}
	held, err := a.file.Stat()
	if err != nil || !os.SameFile(held, a.identity) {
		return errMeetingDirectoryChanged
	}
	return nil
}
func (d *meetingArchiveDirectory) verify() error {
	if err := d.root.verify(); err != nil {
		return err
	}
	if d.parent == nil {
		return nil
	}
	if err := d.parent.verify(); err != nil {
		return err
	}
	peer, err := openMeetingDirectoryChild(d.parent.file, d.name, false)
	if err != nil {
		return errMeetingDirectoryChanged
	}
	defer peer.Close()
	info, err := peer.Stat()
	if err != nil || !os.SameFile(info, d.identity) {
		return errMeetingDirectoryChanged
	}
	return nil
}
func (d *meetingArchiveDirectory) child(name string, create bool) (*meetingArchiveDirectory, error) {
	if name == "" || name == "." || name == ".." || filepath.Base(name) != name || strings.ContainsAny(name, `/\`) {
		return nil, errMeetingDirectoryChanged
	}
	if err := d.verify(); err != nil {
		return nil, err
	}
	file, err := openMeetingDirectoryChild(d.file, name, create)
	if err != nil {
		return nil, err
	}
	d.root.opened = append(d.root.opened, file)
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	child := &meetingArchiveDirectory{root: d.root, parent: d, file: file, name: name, path: filepath.Join(d.path, name), identity: info}
	if err := child.verify(); err != nil {
		_ = file.Close()
		return nil, err
	}
	return child, nil
}
func (a *meetingArchiveRoot) directory(path string, create bool) (*meetingArchiveDirectory, error) {
	rel, err := filepath.Rel(a.original, filepath.Clean(path))
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
		return nil, errors.New("meeting folder would fall outside its configured root")
	}
	dir := &meetingArchiveDirectory{root: a, file: a.file, path: a.original, identity: a.identity}
	if rel == "." {
		return dir, dir.verify()
	}
	for _, name := range strings.Split(rel, string(os.PathSeparator)) {
		dir, err = dir.child(name, create)
		if err != nil {
			return nil, err
		}
	}
	return dir, dir.verify()
}
func (d *meetingArchiveDirectory) createSubdirs() error {
	var failed []string
	for _, name := range meetingSubdirs {
		child, err := d.child(name, true)
		if err != nil {
			failed = append(failed, name)
			continue
		}
		_ = child.file.Close()
	}
	if err := d.verify(); err != nil {
		return err
	}
	if len(failed) > 0 {
		return fmt.Errorf("meeting subfolders not created: %s", strings.Join(failed, ", "))
	}
	return nil
}
func (d *meetingArchiveDirectory) entries(ctx context.Context, limit int) ([]string, bool, error) {
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
			child, openErr := openMeetingDirectoryChild(d.file, name, false)
			if openErr != nil {
				if errors.Is(openErr, errMeetingDirectoryChanged) || os.IsNotExist(openErr) {
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
	if err := d.verify(); err != nil {
		return nil, false, err
	}
	sort.Strings(entries)
	return entries, truncated, nil
}
func (d *meetingArchiveDirectory) visibleCount(ctx context.Context) (int, error) {
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
	return count, d.verify()
}

func childDirNamedInRoot(root, parent, want string) string {
	archive, err := openMeetingArchive(root)
	if err != nil {
		return ""
	}
	defer archive.close()
	dir, err := archive.directory(parent, false)
	if err != nil {
		return ""
	}
	target, match := normalizeDirMatch(want), ""
	for {
		names, err := dir.file.Readdirnames(128)
		for _, name := range names {
			if normalizeDirMatch(name) != target || (match != "" && name >= match) {
				continue
			}
			child, openErr := dir.child(name, false)
			if openErr == nil {
				match = name
				_ = child.file.Close()
			}
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return ""
		}
	}
	if dir.verify() != nil {
		return ""
	}
	return match
}

func provisionMeetingArchive(plan meetingDirPlan, name string) (string, error, error) {
	archive, err := openMeetingArchive(plan.Root)
	if err != nil {
		return "", nil, err
	}
	defer archive.close()
	base, err := archive.directory(plan.Dir, true)
	if err != nil {
		return "", nil, err
	}
	meeting, err := base.child(sanitizeMeetingFolderName(name), true)
	if err != nil {
		return "", nil, err
	}
	subErr := meeting.createSubdirs()
	if err := meeting.verify(); err != nil {
		return "", nil, err
	}
	return meeting.path, subErr, nil
}
