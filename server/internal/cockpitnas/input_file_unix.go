//go:build darwin || linux

package cockpitnas

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

const inputFileByteLimit int64 = 500 << 20

type inputNativeStat struct {
	Device, Inode               uint64
	Size, ModifiedNS, ChangedNS int64
	Mode                        uint32
}

func (s inputNativeStat) identity() string {
	return preparationHash([]any{s.Device, s.Inode, s.Size, s.ModifiedNS, s.ChangedNS, s.Mode})
}
func inputStat(file *os.File) (inputNativeStat, error) {
	var s unix.Stat_t
	err := unix.Fstat(int(file.Fd()), &s)
	if err != nil {
		return inputNativeStat{}, err
	}
	return inputStatValue(s), nil
}
func inputStatAt(parent *os.File, name string) (inputNativeStat, error) {
	var s unix.Stat_t
	err := unix.Fstatat(int(parent.Fd()), name, &s, unix.AT_SYMLINK_NOFOLLOW)
	if err != nil {
		return inputNativeStat{}, err
	}
	return inputStatValue(s), nil
}
func inputIO(err error) error {
	var e *Error
	if errors.As(err, &e) {
		copy := *e
		copy.Message = strings.ReplaceAll(copy.Message, "preparation", "input")
		return &copy
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return fail("io_timeout", "The input observation did not finish within its time budget.", true)
	}
	if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
		return fail("symlink_not_allowed", "The input path contains a symbolic link or a non-directory component.", false)
	}
	if errors.Is(err, unix.ENOENT) {
		return fail("source_unavailable", "The selected input path is no longer available.", false)
	}
	if errors.Is(err, unix.EACCES) || errors.Is(err, unix.EPERM) {
		return fail("permission_denied", "The server cannot read this input with its current filesystem permissions.", false)
	}
	return fail("storage_unavailable", "The input filesystem could not be read.", true)
}
func inputSourceChanged() error {
	return fail("source_changed", "The selected file changed. Browse it again before confirming a new source.", false)
}
func openInputOrdinary(parent *os.File, name string) (*os.File, error) {
	fd, err := unix.Openat(int(parent.Fd()), name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, inputIO(err)
	}
	file := os.NewFile(uintptr(fd), name)
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, inputIO(err)
	}
	if !info.Mode().IsRegular() {
		file.Close()
		return nil, fail("unsupported_file", "Only an ordinary file can be selected as an input.", false)
	}
	if info.Size() < 0 || info.Size() > inputFileByteLimit {
		file.Close()
		return nil, fail("file_too_large", "The selected input exceeds the file size limit.", false)
	}
	return file, nil
}

type inputHeldFile struct {
	ctx                      context.Context
	root                     *preparationHandle
	parent, file             *os.File
	relative, parentRelative string
	original                 inputNativeStat
	rootIdentity             string
	closeOnce                sync.Once
	closeError               error
}

func openInputObservedFile(ctx context.Context, root Root, relative string) (*inputHeldFile, error) {
	if err := ctx.Err(); err != nil {
		return nil, inputIO(err)
	}
	if !validInputRelative(relative) || relative == "." || filepath.Base(relative) == MarkerName {
		return nil, fail("invalid_input_path", "Choose an ordinary file within the input scope.", false)
	}
	h, err := openPreparationRoot(root)
	if err != nil {
		return nil, inputIO(err)
	}
	parentRelative := filepath.Dir(relative)
	parent, closeParent, err := openInputPath(ctx, h.root, parentRelative)
	if err != nil {
		h.close()
		return nil, inputIO(err)
	}
	file, err := openInputOrdinary(parent, filepath.Base(relative))
	if err != nil {
		closeParent()
		h.close()
		return nil, err
	}
	held := &inputHeldFile{ctx: ctx, root: h, parent: parent, file: file, relative: relative, parentRelative: parentRelative}
	held.original, err = inputStat(file)
	if err == nil {
		held.rootIdentity, err = directoryIdentity(h.root)
	}
	if err == nil {
		err = held.verify()
	}
	if err != nil {
		held.closeFiles()
		return nil, inputIO(err)
	}
	return held, nil
}
func (h *inputHeldFile) verify() error {
	if err := h.ctx.Err(); err != nil {
		return inputIO(err)
	}
	current, err := inputStat(h.file)
	if err != nil {
		return inputIO(err)
	}
	if current != h.original {
		return inputSourceChanged()
	}
	if err = verifyInputDirectory(h.ctx, h.root, h.parentRelative, h.parent); err != nil {
		return inputIO(err)
	}
	path, err := openInputOrdinary(h.parent, filepath.Base(h.relative))
	if err != nil {
		return inputIO(err)
	}
	defer path.Close()
	observed, err := inputStat(path)
	if err != nil {
		return inputIO(err)
	}
	if observed != h.original {
		return inputSourceChanged()
	}
	return nil
}
func (h *inputHeldFile) Read(buffer []byte) (int, error) {
	if err := h.ctx.Err(); err != nil {
		return 0, inputIO(err)
	}
	n, err := h.file.Read(buffer)
	if err == io.EOF {
		if changed := h.verify(); changed != nil {
			return n, changed
		}
		return n, io.EOF
	}
	if err != nil {
		return n, inputIO(err)
	}
	return n, nil
}
func (h *inputHeldFile) closeFiles() error {
	fileErr := h.file.Close()
	var parentErr error
	if h.parent != h.root.root {
		parentErr = h.parent.Close()
	}
	rootErr := h.root.root.Close()
	anchorErr := h.root.anchor.Close()
	return errors.Join(fileErr, parentErr, rootErr, anchorErr)
}
func (h *inputHeldFile) Close() error {
	h.closeOnce.Do(func() {
		verifyErr := h.verify()
		closeErr := h.closeFiles()
		if closeErr != nil {
			closeErr = inputIO(closeErr)
		}
		h.closeError = errors.Join(verifyErr, closeErr)
	})
	return h.closeError
}

// Retain only root and final descriptors; path depth cannot multiply the
// number of descriptors held by a browser session.
func openInputPath(ctx context.Context, root *os.File, relative string) (*os.File, func(), error) {
	current := root
	closeCurrent := func() {
		if current != root {
			_ = current.Close()
		}
	}
	if relative == "." {
		return root, func() {}, nil
	}
	for _, part := range strings.Split(relative, "/") {
		if err := ctx.Err(); err != nil {
			closeCurrent()
			return nil, func() {}, err
		}
		next, err := openDirectory(current, part)
		if err != nil {
			if errors.Is(err, unix.ENOTDIR) {
				var st unix.Stat_t
				if e := unix.Fstatat(int(current.Fd()), part, &st, unix.AT_SYMLINK_NOFOLLOW); e == nil && st.Mode&unix.S_IFMT == unix.S_IFLNK {
					err = unix.ELOOP
				}
			}
			closeCurrent()
			return nil, func() {}, err
		}
		closeCurrent()
		current = next
	}
	return current, closeCurrent, nil
}

func verifyInputDirectory(ctx context.Context, held *preparationHandle, relative string, directory *os.File) error {
	if err := ctx.Err(); err != nil {
		return inputIO(err)
	}
	current, err := openPreparationRoot(held.config)
	if err != nil {
		return inputIO(err)
	}
	defer current.close()
	if err = sameDirectory(held.root, current.root); err != nil {
		return inputSourceChanged()
	}
	fresh, closeFresh, err := openInputPath(ctx, current.root, relative)
	if err != nil {
		return inputIO(err)
	}
	defer closeFresh()
	if err = sameDirectory(directory, fresh); err != nil {
		return inputSourceChanged()
	}
	return nil
}
