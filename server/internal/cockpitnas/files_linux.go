package cockpitnas

import (
	"golang.org/x/sys/unix"
	"os"
)

func renameNoReplace(fd int, from, to string) error {
	return unix.Renameat2(fd, from, fd, to, unix.RENAME_NOREPLACE)
}

func isNetworkMount(file *os.File) (bool, error) {
	var stat unix.Statfs_t
	if err := unix.Fstatfs(int(file.Fd()), &stat); err != nil {
		return false, err
	}
	return stat.Type == unix.NFS_SUPER_MAGIC || stat.Type == unix.SMB_SUPER_MAGIC || stat.Type == unix.SMB2_SUPER_MAGIC || stat.Type == 0xff534d42, nil
}
