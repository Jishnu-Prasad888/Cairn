package backups

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/audit"
	"github.com/Jishnu-Prasad888/Cairn/internal/crypto"
	"github.com/Jishnu-Prasad888/Cairn/internal/library"
	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
)

func newLibraryManager(pool *sql.DB) *library.Manager {
	return library.NewManager(pool, testLogger(), audit.New(pool, testLogger()), crypto.NewKeys(""))
}

func TestDestinationNormalizeAndKey(t *testing.T) {
	d, err := Destination{Kind: "SFTP", Host: "nas.local", Username: "me", Path: "backups/cairn/"}.Normalize()
	if err != nil {
		t.Fatal(err)
	}
	if got := d.Key(); got != "sftp://me@nas.local:22/backups/cairn" {
		t.Errorf("sftp key = %q", got)
	}
	if got := d.Location("cairn-backup-1"); got != "sftp://me@nas.local:22/backups/cairn/cairn-backup-1" {
		t.Errorf("location = %q", got)
	}

	f, err := Destination{Kind: "ftp", Host: "ftp.example", Security: FTPSecurityImplicit}.Normalize()
	if err != nil {
		t.Fatal(err)
	}
	if f.Username != "anonymous" || f.port() != 990 {
		t.Errorf("ftp defaults = user %q port %d", f.Username, f.port())
	}

	s, err := Destination{Kind: "smb", Host: "nas", Share: `\photos\`, Username: "u", Path: "/cairn"}.Normalize()
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Key(); got != "smb://u@nas:445/photos/cairn" {
		t.Errorf("smb key = %q", got)
	}

	for _, bad := range []Destination{
		{Kind: "local", Path: "relative"},
		{Kind: "sftp", Host: "h"},               // no username
		{Kind: "smb", Host: "h", Username: "u"}, // no share
		{Kind: "ftp", Host: "ftp://h"},          // URL, not host
		{Kind: "ftp", Host: "h", Security: "maybe"},
		{Kind: "webdav", Host: "h"},
	} {
		if _, err := bad.Normalize(); err == nil {
			t.Errorf("Normalize(%+v) accepted an invalid destination", bad)
		}
	}
}

func TestParseMountInfo(t *testing.T) {
	data := `22 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw
40 22 0:5 / /proc rw - proc proc rw
91 22 8:17 / /media/me/My\040Drive rw,nosuid shared:50 - exfat /dev/sdb1 rw
92 22 0:50 / /mnt/nas rw - nfs4 nas:/export rw
`
	entries := parseMountInfo(data)
	if len(entries) != 4 {
		t.Fatalf("entries = %d, want 4", len(entries))
	}
	if entries[2].point != "/media/me/My Drive" || entries[2].fsType != "exfat" {
		t.Errorf("escaped mount = %+v", entries[2])
	}
	if mp, _ := mountPointOf(entries, "/media/me/My Drive/cairn/backups"); mp != "/media/me/My Drive" {
		t.Errorf("mountPointOf = %q", mp)
	}
	if mp, _ := mountPointOf(entries, "/home/me"); mp != "/" {
		t.Errorf("mountPointOf root path = %q", mp)
	}
	if !isMountPoint(entries, "/mnt/nas") || isMountPoint(entries, "/mnt/usb") {
		t.Error("isMountPoint wrong")
	}
}

// TestUnmountedDriveWaitsInsteadOfWritingToSystemDisk is the mounted-drive
// guarantee: when the remembered mount is gone, a run is refused as
// unavailable and nothing is created at the destination path.
func TestUnmountedDriveWaitsInsteadOfWritingToSystemDisk(t *testing.T) {
	if _, err := readMounts(); err != nil {
		t.Skip("no mount table on this platform")
	}
	pool, serverPath := tempServerDB(t)
	registerLibrary(t, newLibraryManager(pool), filepath.Join(t.TempDir(), "lima"))
	dir := filepath.Join(t.TempDir(), "usb", "cairn")
	m := newManager(t, pool, serverPath, dir, "", 4)
	m.mu.Lock()
	m.dest.MountPoint = filepath.Dir(dir) // not actually a mount point
	m.mu.Unlock()

	_, err := m.Run(context.Background())
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("run err = %v, want ErrUnavailable", err)
	}
	if _, err := os.Stat(dir); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("destination was created on the wrong disk: %v", err)
	}
	if recs, _ := m.List(context.Background(), 10); len(recs) != 0 {
		t.Fatalf("an unavailable drive recorded %d backups, want none", len(recs))
	}
}

func TestSecretsAreSealedInDatabase(t *testing.T) {
	pool, serverPath := tempServerDB(t)
	ctx := context.Background()
	dataDir := t.TempDir()
	m := newManager(t, pool, serverPath, "", "", 4)
	m.secrets = newSecretBox(dataDir)
	// Accept any remote: the probe writes into a local directory.
	root := t.TempDir()
	m.open = func(_ context.Context, d Destination, onHostKey func(string)) (Target, error) {
		if onHostKey != nil && d.HostKey == "" {
			onHostKey("SHA256:test")
		}
		return newLocalTarget(root), nil
	}

	pw := "hunter2-very-secret"
	saved, err := m.SetDestination(ctx, DestinationUpdate{
		Destination: Destination{Kind: KindSFTP, Host: "nas", Username: "me", Path: "cairn"},
		Password:    &pw,
	})
	if err != nil {
		t.Fatalf("set destination: %v", err)
	}
	if saved.HostKey != "SHA256:test" {
		t.Fatalf("host key not pinned: %q", saved.HostKey)
	}
	var raw string
	if err := pool.QueryRow(`SELECT value FROM server_settings WHERE key = ?`, destinationKey).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, pw) {
		t.Fatal("password stored in the clear")
	}

	// A restart unseals it with the key file.
	again := newManager(t, pool, serverPath, "", "", 4)
	again.secrets = newSecretBox(dataDir)
	if err := again.Load(ctx); err != nil {
		t.Fatal(err)
	}
	if got := again.Destination(); got.Password != pw || got.Kind != KindSFTP || got.HostKey != "SHA256:test" {
		t.Fatalf("reloaded destination = %+v", got)
	}

	// An edit that leaves the password out keeps it.
	again.open = m.open
	if _, err := again.SetDestination(ctx, DestinationUpdate{
		Destination: Destination{Kind: KindSFTP, Host: "nas", Username: "me", Path: "other"},
	}); err != nil {
		t.Fatal(err)
	}
	if got := again.Destination(); got.Password != pw || got.Path != "other" {
		t.Fatalf("edited destination = %+v", got)
	}
}

// insertIndexed adds an indexed_files row as the indexer would.
func insertIndexed(t *testing.T, root, rel string, size int64, seen time.Time) {
	t.Helper()
	db, err := librarydb.Open(filepath.Join(root, ".cairn"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	ts := seen.UTC().Format(time.RFC3339Nano)
	old := seen.Add(-24 * 365 * time.Hour).UTC().Format(time.RFC3339Nano)
	if _, err := db.Exec(`INSERT INTO indexed_files
		(id, rel_path, size_bytes, mod_time, status, first_seen_at, last_seen_at, indexed_at)
		VALUES (?, ?, ?, ?, 'present', ?, ?, ?)`, rel, rel, size, old, ts, ts, ts); err != nil {
		t.Fatal(err)
	}
}

func TestSizeTriggers(t *testing.T) {
	tr := Triggers{SingleFileBytes: 100, TotalBytes: 1000}
	if _, ok := tr.Exceeds(Pending{Bytes: 500, LargestBytes: 99}); ok {
		t.Error("below both thresholds fired")
	}
	if _, ok := tr.Exceeds(Pending{Bytes: 150, LargestBytes: 150}); !ok {
		t.Error("single large file did not fire")
	}
	if _, ok := tr.Exceeds(Pending{Bytes: 1000, LargestBytes: 10}); !ok {
		t.Error("many small files did not fire")
	}
	if _, ok := (Triggers{TotalBytes: 1000}).Exceeds(Pending{Bytes: 999, LargestBytes: 999}); ok {
		t.Error("disabled single-file threshold fired")
	}

	pool, serverPath := tempServerDB(t)
	ctx := context.Background()
	root := filepath.Join(t.TempDir(), "mike")
	registerLibrary(t, newLibraryManager(pool), root)
	m := newManager(t, pool, serverPath, filepath.Join(t.TempDir(), "b"), "", 4)

	rec, err := m.Run(ctx)
	if err != nil || rec.Status != StatusCompleted {
		t.Fatalf("baseline backup: %v %+v", err, rec)
	}
	insertIndexed(t, root, "old.jpg", 5000, rec.StartedAt.Add(-time.Hour))
	insertIndexed(t, root, "new-a.mp4", 300, time.Now().Add(time.Minute))
	insertIndexed(t, root, "new-b.mp4", 700, time.Now().Add(time.Minute))

	p, err := m.pending(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if p.Files != 2 || p.Bytes != 1000 || p.LargestBytes != 700 {
		t.Fatalf("pending = %+v, want 2 files / 1000 bytes / largest 700", p)
	}
	if _, ok := m.sizeExceeded(ctx, Triggers{TotalBytes: 1000}); !ok {
		t.Error("total trigger should fire")
	}
	if _, ok := m.sizeExceeded(ctx, Triggers{SingleFileBytes: 701}); ok {
		t.Error("single-file trigger should not fire for a 700-byte file")
	}
}
