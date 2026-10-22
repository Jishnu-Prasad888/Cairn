package backups

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
)

// Mount is one mounted filesystem the server can see, offered as a backup
// destination (USB drives, second disks, NFS/CIFS mounts).
type Mount struct {
	Path       string `json:"path"`
	Device     string `json:"device"`
	FSType     string `json:"fs_type"`
	TotalBytes uint64 `json:"total_bytes"`
	FreeBytes  uint64 `json:"free_bytes"`
	// Removable is a best-effort hint: the mount lives under a conventional
	// removable-media directory (/media, /run/media, /mnt) or the block
	// device reports itself removable.
	Removable bool `json:"removable"`
	// Network is set for network filesystems (NFS, CIFS, SSHFS, ...).
	Network bool `json:"network"`
	// System marks the root filesystem: a backup there does not survive
	// losing the system disk.
	System bool `json:"system"`
}

// pseudoFS are kernel/virtual filesystems that are never backup targets.
var pseudoFS = map[string]bool{
	"proc": true, "sysfs": true, "devtmpfs": true, "devpts": true, "tmpfs": true,
	"cgroup": true, "cgroup2": true, "securityfs": true, "pstore": true,
	"debugfs": true, "tracefs": true, "configfs": true, "fusectl": true,
	"mqueue": true, "hugetlbfs": true, "bpf": true, "autofs": true,
	"binfmt_misc": true, "efivarfs": true, "rpc_pipefs": true, "nsfs": true,
	"overlay": true, "squashfs": true, "ramfs": true, "fuse.portal": true,
	"fuse.gvfsd-fuse": true, "selinuxfs": true, "erofs": true,
}

var networkFS = map[string]bool{
	"nfs": true, "nfs4": true, "cifs": true, "smb3": true, "smbfs": true,
	"fuse.sshfs": true, "fuse.rclone": true, "9p": true, "ceph": true,
	"glusterfs": true, "davfs": true, "fuse.davfs2": true,
}

// mountEntry is one parsed mount table row.
type mountEntry struct {
	point  string
	device string
	fsType string
}

// mountPointOf returns the mount point containing path: the longest mount
// prefix. ok is false when the mount table is unavailable.
func mountPointOf(entries []mountEntry, p string) (string, bool) {
	if len(entries) == 0 {
		return "", false
	}
	p = filepath.Clean(p)
	best := ""
	for _, e := range entries {
		if e.point == "/" || p == e.point || strings.HasPrefix(p, e.point+string(filepath.Separator)) {
			if len(e.point) > len(best) {
				best = e.point
			}
		}
	}
	return best, best != ""
}

// isMountPoint reports whether point is currently a mount point.
func isMountPoint(entries []mountEntry, point string) bool {
	for _, e := range entries {
		if e.point == point {
			return true
		}
	}
	return false
}

// MountPointFor reports the mount a local destination path lives on, or ""
// when it is on the root filesystem or the mount table is unavailable.
func MountPointFor(p string) string {
	entries, err := readMounts()
	if err != nil {
		return ""
	}
	// The path may not exist yet; walk up to the nearest existing ancestor is
	// unnecessary, since mount points are matched by prefix.
	mp, ok := mountPointOf(entries, p)
	if !ok || mp == "/" {
		return ""
	}
	return mp
}

// checkMounted refuses a local destination whose drive is not mounted. Without
// it an unplugged USB disk leaves an empty directory behind on the system disk
// and the backup would silently fill that instead.
func checkMounted(d Destination) error {
	if d.MountPoint == "" {
		return nil
	}
	entries, err := readMounts()
	if err != nil {
		return nil // no mount table (non-Linux): nothing to check against
	}
	if !isMountPoint(entries, d.MountPoint) {
		return fmt.Errorf("%w: the backup drive at %s is not mounted", ErrUnavailable, d.MountPoint)
	}
	return nil
}

// ListMounts returns mounted filesystems that could hold backups, real disks
// and network mounts first, the system disk last.
func ListMounts() ([]Mount, error) {
	entries, err := readMounts()
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var out []Mount
	for _, e := range entries {
		if pseudoFS[e.fsType] || seen[e.point] {
			continue
		}
		if strings.HasPrefix(e.point, "/proc") || strings.HasPrefix(e.point, "/sys") ||
			strings.HasPrefix(e.point, "/dev") || strings.HasPrefix(e.point, "/boot") ||
			strings.HasPrefix(e.point, "/snap/") || strings.HasPrefix(e.point, "/var/lib/docker") ||
			e.point == "/run" || (strings.HasPrefix(e.point, "/run/") && !strings.HasPrefix(e.point, "/run/media/")) {
			continue
		}
		seen[e.point] = true
		m := Mount{
			Path:    e.point,
			Device:  e.device,
			FSType:  e.fsType,
			Network: networkFS[e.fsType],
			System:  e.point == "/",
			Removable: strings.HasPrefix(e.point, "/media/") || strings.HasPrefix(e.point, "/run/media/") ||
				strings.HasPrefix(e.point, "/mnt/") || deviceRemovable(e.device),
		}
		m.TotalBytes, m.FreeBytes = diskSpace(e.point)
		if m.TotalBytes == 0 && !m.Network {
			continue // unreadable or empty pseudo mount
		}
		out = append(out, m)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].System != out[j].System {
			return !out[i].System
		}
		return out[i].Path < out[j].Path
	})
	return out, nil
}

// unescapeMount decodes the octal escapes (\040 for space, ...) used in the
// kernel mount table.
func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+4 <= len(s) {
			if v, ok := octal3(s[i+1 : i+4]); ok {
				b.WriteByte(v)
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func octal3(s string) (byte, bool) {
	if len(s) != 3 {
		return 0, false
	}
	var v int
	for _, c := range s {
		if c < '0' || c > '7' {
			return 0, false
		}
		v = v*8 + int(c-'0')
	}
	if v > 255 {
		return 0, false
	}
	return byte(v), true
}

// parseMountInfo parses /proc/self/mountinfo.
func parseMountInfo(data string) []mountEntry {
	var out []mountEntry
	for _, line := range strings.Split(data, "\n") {
		// id parent major:minor root mountpoint opts [optional...] - fstype source superopts
		left, right, ok := strings.Cut(line, " - ")
		if !ok {
			continue
		}
		lf := strings.Fields(left)
		rf := strings.Fields(right)
		if len(lf) < 5 || len(rf) < 2 {
			continue
		}
		out = append(out, mountEntry{
			point:  unescapeMount(lf[4]),
			fsType: rf[0],
			device: unescapeMount(rf[1]),
		})
	}
	return out
}
