//go:build darwin || linux

package collabfs

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func openPath(path string) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), path), nil
}

func openChild(parent *os.File, name string, create bool) (*os.File, error) {
	if create {
		if err := unix.Mkdirat(int(parent.Fd()), name, 0o755); err != nil && !errors.Is(err, unix.EEXIST) {
			return nil, err
		}
	}
	fd, err := unix.Openat(int(parent.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
		return nil, ErrDirectoryChanged
	}
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), name), nil
}

func isCrossDevice(err error) bool {
	return errors.Is(err, unix.EXDEV)
}
