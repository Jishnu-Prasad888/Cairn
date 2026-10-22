//go:build linux

package backups

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func readMounts() ([]mountEntry, error) {
	b, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return nil, err
	}
	return parseMountInfo(string(b)), nil
}

func diskSpace(p string) (total, free uint64) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(p, &st); err != nil {
		return 0, 0
	}
	bs := uint64(st.Bsize) //nolint:gosec // block size is never negative
	return st.Blocks * bs, st.Bavail * bs
}

// deviceRemovable reads the block device's removable flag from sysfs
// (/dev/sdb1 → /sys/class/block/sdb1/../removable).
func deviceRemovable(dev string) bool {
	if !strings.HasPrefix(dev, "/dev/") {
		return false
	}
	name := filepath.Base(dev)
	sys, err := filepath.EvalSymlinks(filepath.Join("/sys/class/block", name))
	if err != nil {
		return false
	}
	for _, p := range []string{filepath.Join(sys, "removable"), filepath.Join(filepath.Dir(sys), "removable")} {
		if b, err := os.ReadFile(p); err == nil {
			return strings.TrimSpace(string(b)) == "1"
		}
	}
	return false
}
