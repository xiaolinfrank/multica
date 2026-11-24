//go:build darwin || linux

package collabfs

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// copyTree copies a directory across filesystems. It walks with Lstat and
// refuses symlinks, so a link planted inside the tree cannot make the copy
// write outside the destination.
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			return fmt.Errorf("%w: refusing symlink %q while moving a folder", ErrDirectoryChanged, path)
		case info.IsDir():
			return os.MkdirAll(target, info.Mode().Perm()|0o700)
		case info.Mode().IsRegular():
			return copyFile(path, target, info.Mode().Perm())
		default:
			return fmt.Errorf("%w: refusing special file %q while moving a folder", ErrDirectoryChanged, path)
		}
	})
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// removeTree deletes a directory after the same symlink check: the copy already
// refused special entries, but the source may have changed since.
func removeTree(path string) error {
	var visitErr error
	err := filepath.WalkDir(path, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, statErr := os.Lstat(p)
		if statErr != nil {
			return statErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			visitErr = fmt.Errorf("%w: refusing symlink %q while clearing a moved folder", ErrDirectoryChanged, p)
			return visitErr
		}
		return nil
	})
	if err != nil {
		return err
	}
	if visitErr != nil {
		return visitErr
	}
	return os.RemoveAll(path)
}
