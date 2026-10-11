package cockpitnas

import "golang.org/x/sys/unix"

func inputStatValue(s unix.Stat_t) inputNativeStat {
	return inputNativeStat{Device: uint64(s.Dev), Inode: s.Ino, Size: s.Size, Mode: uint32(s.Mode), ModifiedNS: s.Mtim.Sec*1e9 + s.Mtim.Nsec, ChangedNS: s.Ctim.Sec*1e9 + s.Ctim.Nsec}
}
