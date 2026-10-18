//go:build darwin || linux

package cockpitnas

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

const platformSupported = true

func openDirectory(parent *os.File, name string) (*os.File, error) {
	fd, err := unix.Openat(int(parent.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), name), nil
}

func readRegular(parent *os.File, name string, limit int64) ([]byte, error) {
	fd, err := unix.Openat(int(parent.Fd()), name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), name)
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, fail("file_conflict", "The destination contains an unexpected file; it was not overwritten.", false)
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err == nil && int64(len(data)) > limit {
		return nil, fail("file_conflict", "The destination contains a larger file; it was not overwritten.", false)
	}
	return data, err
}

func classifyIO(err error, unavailable string) error {
	var typed *Error
	if errors.As(err, &typed) {
		return typed
	}
	if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
		return fail("unsafe_path", "The export path contains a link or an unexpected directory entry.", false)
	}
	if errors.Is(err, unix.EACCES) || errors.Is(err, unix.EPERM) {
		return fail("permission_denied", "The server cannot access the configured NAS destination.", false)
	}
	return fail("storage_unavailable", unavailable, true)
}

func pathChanged() error {
	return fail("path_changed", "The export directory moved or was replaced; its original target could not be confirmed.", false)
}

func classifyReopen(err error) error {
	if errors.Is(err, unix.ENOENT) || errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
		return pathChanged()
	}
	return classifyIO(err, "The export directory could not be rechecked.")
}

func sameDirectory(held, current *os.File) error {
	before, err := held.Stat()
	if err != nil {
		return classifyReopen(err)
	}
	after, err := current.Stat()
	if err != nil {
		return classifyReopen(err)
	}
	if !before.IsDir() || !after.IsDir() || !os.SameFile(before, after) {
		return pathChanged()
	}
	return nil
}

// Pinned descriptors protect traversal but do not pin a directory's name. A
// human can move the opened directory while the export is in progress. Reopen
// the configured path and compare device/inode identities before commit and
// receipt; neither check promises to prevent a later external rename.
func verifyExportDirectories(root Root, relativeMeeting string, heldRoot, heldMeeting, heldPublished *os.File) error {
	anchor, err := os.OpenRoot(root.Path)
	if err != nil {
		return classifyReopen(err)
	}
	defer anchor.Close()
	currentRoot, err := anchor.Open(".")
	if err != nil {
		return classifyReopen(err)
	}
	defer currentRoot.Close()
	if err := sameDirectory(heldRoot, currentRoot); err != nil {
		return err
	}
	if !root.AllowLocal {
		mounted, err := isNetworkMount(currentRoot)
		if err != nil || !mounted {
			return fail("mount_unavailable", "The configured root is not on an available network filesystem.", true)
		}
	}
	marker, err := readRegular(currentRoot, MarkerName, 128)
	if err != nil {
		return classifyReopen(err)
	}
	if strings.TrimSpace(string(marker)) != root.RootID {
		return fail("identity_mismatch", "The NAS root identity does not match its configuration.", false)
	}
	current := currentRoot
	var opened []*os.File
	defer func() {
		for i := len(opened) - 1; i >= 0; i-- {
			_ = opened[i].Close()
		}
	}()
	if relativeMeeting != "." {
		for _, component := range strings.Split(relativeMeeting, string(filepath.Separator)) {
			next, err := openDirectory(current, component)
			if err != nil {
				return classifyReopen(err)
			}
			opened = append(opened, next)
			current = next
		}
	}
	if err := sameDirectory(heldMeeting, current); err != nil {
		return err
	}
	published, err := openDirectory(current, PublishedDirectory)
	if err != nil {
		return classifyReopen(err)
	}
	defer published.Close()
	return sameDirectory(heldPublished, published)
}

func (f *Files) syncExportDirectory(directory *os.File) error {
	var err error
	if f.syncDirectory != nil {
		err = f.syncDirectory(directory)
	} else {
		err = directory.Sync()
	}
	if err == nil {
		return nil
	}
	if errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.EINVAL) {
		return fail("unsupported_sync", "This filesystem cannot confirm synchronization of the exported directory.", false)
	}
	return classifyIO(err, "The exported directory could not be synchronized; verification will be retried.")
}

// Filesystem calls remain synchronous in the bounded worker. Context cannot
// interrupt a blocked kernel NAS operation; no detached I/O goroutines are used.
func (f *Files) Write(ctx context.Context, request Request) (Result, error) {
	if request.Destination.WriteMode == ModeCreateOnly {
		return f.writeCreateOnly(ctx, request)
	}
	root, err := f.validate(request)
	if err != nil {
		return Result{}, err
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	anchor, err := os.OpenRoot(root.Path)
	if err != nil {
		return Result{}, classifyIO(err, "The configured NAS root is unavailable.")
	}
	defer anchor.Close()
	rootDir, err := anchor.Open(".")
	if err != nil {
		return Result{}, classifyIO(err, "The configured NAS root is unavailable.")
	}
	defer rootDir.Close()
	if !root.AllowLocal {
		mounted, err := isNetworkMount(rootDir)
		if err != nil || !mounted {
			return Result{}, fail("mount_unavailable", "The configured root is not on an available network filesystem.", true)
		}
	}
	marker, err := readRegular(rootDir, MarkerName, 128)
	if err != nil {
		return Result{}, classifyIO(err, "The NAS identity marker is unavailable.")
	}
	if strings.TrimSpace(string(marker)) != root.RootID {
		return Result{}, fail("identity_mismatch", "The NAS root identity does not match its configuration.", false)
	}

	// Open each existing meeting-directory component relative to an anchored
	// descriptor. O_NOFOLLOW rejects symlink swaps without a stat/open gap.
	dir := rootDir
	var opened []*os.File
	defer func() {
		for i := len(opened) - 1; i >= 0; i-- {
			_ = opened[i].Close()
		}
	}()
	rel, _ := filepath.Rel(root.Path, request.Destination.Directory)
	if rel != "." {
		for _, component := range strings.Split(rel, string(filepath.Separator)) {
			next, err := openDirectory(dir, component)
			if err != nil {
				return Result{}, classifyIO(err, "The meeting directory is unavailable; provision or reconnect it before retrying.")
			}
			opened = append(opened, next)
			dir = next
		}
	}
	if err := unix.Mkdirat(int(dir.Fd()), PublishedDirectory, 0o755); err != nil && !errors.Is(err, unix.EEXIST) {
		return Result{}, classifyIO(err, "The published-minutes directory could not be created.")
	}
	published, err := openDirectory(dir, PublishedDirectory)
	if err != nil {
		return Result{}, classifyIO(err, "The published-minutes directory is unavailable.")
	}
	defer published.Close()
	name := filepath.Base(request.Destination.TargetPath)
	verifyDirectories := func() error {
		return verifyExportDirectories(root, rel, rootDir, dir, published)
	}
	checkExisting := func() (Result, error) {
		if err := verifyDirectories(); err != nil {
			return Result{}, err
		}
		data, err := readRegular(published, name, MaxContentBytes)
		if err != nil {
			return Result{}, classifyIO(err, "The exported file could not be verified.")
		}
		if fmt.Sprintf("%x", sha256.Sum256(data)) != request.ContentHash || string(data) != request.Content {
			return Result{}, fail("file_conflict", "A different file already exists at this destination; it was not overwritten.", false)
		}
		// The prior writer may have committed the rename but lost its directory
		// sync acknowledgement. An existing matching file must finish the same
		// durability step as a new commit before it earns a success receipt.
		if err := f.syncExportDirectory(published); err != nil {
			return Result{}, err
		}
		if f.beforeAck != nil {
			f.beforeAck()
		}
		if err := verifyDirectories(); err != nil {
			return Result{}, err
		}
		return Result{Path: request.Destination.TargetPath, ContentHash: request.ContentHash, Size: int64(len(data))}, nil
	}
	if err := unix.Fstatat(int(published.Fd()), name, &unix.Stat_t{}, unix.AT_SYMLINK_NOFOLLOW); err == nil {
		return checkExisting()
	} else if !errors.Is(err, unix.ENOENT) {
		return Result{}, classifyIO(err, "The destination could not be inspected.")
	}
	temp := ".multica-" + request.OperationID + "-" + request.LeaseToken + ".tmp"
	fd, err := unix.Openat(int(published.Fd()), temp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o644)
	if err != nil {
		return Result{}, classifyIO(err, "The temporary export could not be created.")
	}
	file := os.NewFile(uintptr(fd), temp)
	defer file.Close()
	defer unix.Unlinkat(int(published.Fd()), temp, 0)
	if _, err = io.Copy(file, strings.NewReader(request.Content)); err != nil {
		return Result{}, classifyIO(err, "The NAS write did not complete.")
	}
	if err = file.Sync(); err != nil {
		return Result{}, classifyIO(err, "The NAS write could not be synchronized.")
	}
	if err = file.Close(); err != nil {
		return Result{}, classifyIO(err, "The NAS write could not be closed.")
	}
	if err = ctx.Err(); err != nil {
		return Result{}, err
	}
	if f.beforeCommit != nil {
		f.beforeCommit()
	}
	if err = verifyDirectories(); err != nil {
		return Result{}, err
	}
	if err = renameNoReplace(int(published.Fd()), temp, name); err != nil {
		if errors.Is(err, unix.EEXIST) {
			return checkExisting()
		}
		if errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.EINVAL) {
			return Result{}, fail("unsupported_commit", "This filesystem does not support atomic export without replacement.", false)
		}
		return Result{}, classifyIO(err, "The export could not be committed.")
	}
	return checkExisting()
}
