//go:build darwin || linux

package cockpitnas

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

type preparationHandle struct {
	anchor *os.Root
	root   *os.File
	config Root
}

func preparationIO(err error) error {
	var known *Error
	if errors.As(err, &known) {
		return known
	}
	if errors.Is(err, unix.ELOOP) {
		return fail("symlink_not_allowed", "A directory component is a symbolic link; it was not followed.", false)
	}
	if errors.Is(err, unix.ENOTDIR) {
		return fail("path_is_file", "A non-directory entry occupies the selected path.", false)
	}
	if errors.Is(err, unix.EACCES) || errors.Is(err, unix.EPERM) {
		return fail("permission_denied", "The server cannot access this directory with its current filesystem permissions.", false)
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return fail("io_timeout", "The directory operation did not finish within its observation budget.", true)
	}
	return fail("io_failed", "The directory operation could not be confirmed; inspect the original target before retrying.", true)
}

func openPreparationRoot(root Root) (*preparationHandle, error) {
	info, err := os.Lstat(root.Path)
	if err != nil {
		return nil, fail("root_unavailable", "The configured preparation root is unavailable.", true)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fail("root_identity_mismatch", "The configured preparation root is not its expected directory.", false)
	}
	anchor, err := os.OpenRoot(root.Path)
	if err != nil {
		return nil, preparationIO(err)
	}
	file, err := anchor.Open(".")
	if err != nil {
		anchor.Close()
		return nil, preparationIO(err)
	}
	h := &preparationHandle{anchor: anchor, root: file, config: root}
	failClose := func(err error) (*preparationHandle, error) { h.close(); return nil, err }
	current, err := file.Stat()
	if err != nil || !os.SameFile(info, current) {
		return failClose(fail("root_identity_mismatch", "The preparation root changed while being opened.", false))
	}
	if !root.AllowLocal {
		mounted, e := isNetworkMount(file)
		if e != nil || !mounted {
			return failClose(fail("mount_unavailable", "The preparation root is not on the expected network filesystem.", true))
		}
	}
	marker, err := readRegular(file, MarkerName, 128)
	if err != nil {
		return failClose(preparationIO(err))
	}
	if strings.TrimSpace(string(marker)) != root.RootID {
		return failClose(fail("root_identity_mismatch", "The preparation root identity marker does not match this workspace configuration.", false))
	}
	return h, nil
}

func (h *preparationHandle) close() { _ = h.root.Close(); _ = h.anchor.Close() }

func openPreparationPath(root *os.File, relative string) (*os.File, func(), error) {
	current := root
	opened := []*os.File{}
	closeAll := func() {
		for i := len(opened) - 1; i >= 0; i-- {
			_ = opened[i].Close()
		}
	}
	if relative != "." {
		for _, part := range strings.Split(relative, string(filepath.Separator)) {
			next, err := openDirectory(current, part)
			if err != nil {
				// Darwin may report ENOTDIR for O_NOFOLLOW|O_DIRECTORY on a
				// symlink. Classify that entry without ever following it.
				if errors.Is(err, unix.ENOTDIR) {
					var st unix.Stat_t
					if e := unix.Fstatat(int(current.Fd()), part, &st, unix.AT_SYMLINK_NOFOLLOW); e == nil && st.Mode&unix.S_IFMT == unix.S_IFLNK {
						err = unix.ELOOP
					}
				}
				closeAll()
				return nil, func() {}, err
			}
			opened = append(opened, next)
			current = next
		}
	}
	return current, closeAll, nil
}

func directoryIdentity(f *os.File) (string, error) {
	var stat unix.Stat_t
	if err := unix.Fstat(int(f.Fd()), &stat); err != nil {
		return "", err
	}
	return fmt.Sprintf("%d:%d", stat.Dev, stat.Ino), nil
}

func (h *preparationHandle) verify(relative string, held *os.File) error {
	current, err := openPreparationRoot(h.config)
	if err != nil {
		return err
	}
	defer current.close()
	if err = sameDirectory(h.root, current.root); err != nil {
		return fail("directory_identity_changed", "The configured preparation root changed during the operation.", false)
	}
	path, closePath, err := openPreparationPath(current.root, relative)
	if err != nil {
		return fail("directory_identity_changed", "The prepared directory moved or was replaced before confirmation.", false)
	}
	defer closePath()
	if err = sameDirectory(held, path); err != nil {
		return fail("directory_identity_changed", "The prepared directory no longer identifies the held directory.", false)
	}
	return nil
}

func (f *Files) InspectPreparation(ctx context.Context, t PreparationTarget, paths []string) ([]PreparationInspection, error) {
	release, err := f.acquirePreparation(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	if len(paths) > 32 {
		return nil, fail("invalid_input", "A preparation plan may contain at most 32 directory steps.", false)
	}
	root, err := f.validatePreparation(t, t.RelativeDirectory)
	if err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, preparationIO(err)
	}
	h, err := openPreparationRoot(root)
	if err != nil {
		return nil, err
	}
	defer h.close()
	boundary, closeBoundary, err := openPreparationPath(h.root, t.PrepareSubpath)
	if err != nil {
		return nil, fail("root_unavailable", "The configured preparation boundary must already exist.", true)
	}
	defer closeBoundary()
	if err = h.verify(t.PrepareSubpath, boundary); err != nil {
		return nil, err
	}
	items := make([]PreparationInspection, 0, len(paths))
	for _, relative := range paths {
		if _, err = f.validatePreparation(t, relative); err != nil {
			return nil, err
		}
		if err = ctx.Err(); err != nil {
			return nil, preparationIO(err)
		}
		item := PreparationInspection{RelativePath: relative, State: "exists"}
		directory, closeDirectory, readErr := openPreparationPath(h.root, relative)
		if errors.Is(readErr, unix.ENOENT) {
			item.State = "missing"
		} else if readErr != nil {
			item.State = "unknown"
			typed := preparationIO(readErr).(*Error)
			item.ErrorCode = typed.Code
			if typed.Code == "path_is_file" || typed.Code == "symlink_not_allowed" {
				item.State = "conflict"
			}
		} else if err = h.verify(relative, directory); err != nil {
			item.State = "conflict"
			item.ErrorCode = "directory_identity_changed"
		}
		closeDirectory()
		items = append(items, item)
	}
	if err = h.verify(t.PrepareSubpath, boundary); err != nil {
		return nil, err
	}
	return items, nil
}

// A bounded worker performs synchronous I/O. Context cannot cancel a kernel
// filesystem call; no detached goroutine can outlive a lease unnoticed.
func (f *Files) EnsurePreparedDirectory(ctx context.Context, t PreparationTarget, relative string) (PreparationObservation, error) {
	var result PreparationObservation
	release, err := f.acquirePreparation(ctx)
	if err != nil {
		return result, err
	}
	defer release()
	root, err := f.validatePreparation(t, relative)
	if err != nil {
		return result, err
	}
	if err = ctx.Err(); err != nil {
		return result, preparationIO(err)
	}
	h, err := openPreparationRoot(root)
	if err != nil {
		return result, err
	}
	defer h.close()
	boundary, closeBoundary, err := openPreparationPath(h.root, t.PrepareSubpath)
	if err != nil {
		return result, fail("root_unavailable", "The configured preparation boundary must already exist.", true)
	}
	defer closeBoundary()
	if err = h.verify(t.PrepareSubpath, boundary); err != nil {
		return result, err
	}
	parentRel := filepath.Dir(relative)
	outcome := "observed_existing"
	if relative != t.PrepareSubpath {
		parent, closeParent, e := openPreparationPath(h.root, parentRel)
		if e != nil {
			return result, fail("directory_identity_changed", "The previously prepared parent directory is unavailable; review the fixed plan.", false)
		}
		defer closeParent()
		if err = h.verify(parentRel, parent); err != nil {
			return result, err
		}
		if err = ctx.Err(); err != nil {
			return result, preparationIO(err)
		}
		err = unix.Mkdirat(int(parent.Fd()), filepath.Base(relative), 0o755)
		if err == nil {
			outcome = "created"
		} else if !errors.Is(err, unix.EEXIST) {
			return result, preparationIO(err)
		}
	}
	directory, closeDirectory, err := openPreparationPath(h.root, relative)
	if err != nil {
		return result, preparationIO(err)
	}
	defer closeDirectory()
	if err = h.verify(relative, directory); err != nil {
		return result, err
	}
	if err = h.verify(t.PrepareSubpath, boundary); err != nil {
		return result, err
	}
	id, err := directoryIdentity(directory)
	if err != nil {
		return result, preparationIO(err)
	}
	rootID, err := directoryIdentity(h.root)
	if err != nil {
		return result, preparationIO(err)
	}
	result = PreparationObservation{Directory: filepath.Join(root.Path, relative), DirectoryIdentity: id, RootIdentity: rootID, Outcome: outcome, ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if err = ctx.Err(); err != nil {
		return result, preparationIO(err)
	}
	return result, nil
}
