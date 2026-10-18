package cockpitnas

import (
	"golang.org/x/sys/unix"
	"os"
)

func renameNoReplace(fd int, from, to string) error {
	return unix.RenameatxNp(fd, from, fd, to, unix.RENAME_EXCL)
}

func isNetworkMount(file *os.File) (bool, error) {
	var stat unix.Statfs_t
	if err := unix.Fstatfs(int(file.Fd()), &stat); err != nil {
		return false, err
	}
	kind := unix.ByteSliceToString(stat.Fstypename[:])
	return kind == "smbfs" || kind == "nfs" || kind == "afpfs", nil
}
