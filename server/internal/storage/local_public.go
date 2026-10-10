package storage

import (
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
)

func privateArtifactPath(key string) bool {
	// HTTP routers normally decode once. Refuse encoded aliases too, without
	// using the decoded input to access a different on-disk filename.
	for i := 0; i < 8; i++ {
		decoded, err := url.PathUnescape(key)
		if err != nil {
			return true
		}
		if decoded == key {
			parts := strings.Split(strings.TrimPrefix(path.Clean("/"+strings.ReplaceAll(key, "\\", "/")), "/"), "/")
			return len(parts) >= 3 && strings.EqualFold(parts[0], "workspaces") && strings.EqualFold(parts[2], "artifact-versions")
		}
		key = decoded
	}
	return true
}

// Open one regular file without following a symlink, including a replacement
// between Lstat and Open. The caller retains the directory descriptor.
func openPublicRegular(root *os.Root, name string) (*os.File, error) {
	before, err := root.Lstat(name)
	if err != nil || !before.Mode().IsRegular() {
		return nil, fmt.Errorf("public object is not a regular file")
	}
	f, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	after, err := f.Stat()
	if err != nil || !os.SameFile(before, after) {
		f.Close()
		return nil, fmt.Errorf("public object identity changed")
	}
	return f, nil
}

// Pin every directory independently. Symlink aliases into the private
// namespace cannot turn an innocent URL into a private file read, and an
// attacker cannot change the pathname after validation to change served bytes.
func (s *LocalStorage) openPublicFile(key string) (*os.File, *os.Root, error) {
	clean := filepath.Clean(key)
	if privateArtifactPath(key) || isInternalLocalPath(clean) || !filepath.IsLocal(clean) || clean == "." {
		return nil, nil, fmt.Errorf("object is not public")
	}
	root, err := os.OpenRoot(s.uploadDir)
	if err != nil {
		return nil, nil, err
	}
	parts := strings.Split(clean, string(filepath.Separator))
	for _, component := range parts[:len(parts)-1] {
		before, statErr := root.Lstat(component)
		if statErr != nil || !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
			root.Close()
			return nil, nil, fmt.Errorf("public object directory is unavailable")
		}
		next, openErr := root.OpenRoot(component)
		root.Close()
		if openErr != nil {
			return nil, nil, openErr
		}
		after, statErr := next.Stat(".")
		if statErr != nil || !os.SameFile(before, after) {
			next.Close()
			return nil, nil, fmt.Errorf("public object directory changed")
		}
		root = next
	}
	f, err := openPublicRegular(root, parts[len(parts)-1])
	if err != nil {
		root.Close()
		return nil, nil, err
	}
	return f, root, nil
}
