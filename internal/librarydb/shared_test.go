package librarydb

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newCairnDir(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), ".cairn")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(CloseShared)
	return dir
}

func TestAcquireSharesOnePool(t *testing.T) {
	dir := newCairnDir(t)
	a, releaseA, err := Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	b, releaseB, err := Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatal("two Acquires of one library returned different pools")
	}
	releaseA()
	releaseA() // a second call must not drop another holder's reference
	if err := b.Ping(); err != nil {
		t.Fatalf("pool closed while still held: %v", err)
	}
	releaseB()
	if err := b.Ping(); err != nil {
		t.Fatalf("pool closed before its idle time: %v", err)
	}
}

func TestAcquireClosesIdlePool(t *testing.T) {
	old := sharedIdleTTL
	sharedIdleTTL = 20 * time.Millisecond
	t.Cleanup(func() { sharedIdleTTL = old })

	dir := newCairnDir(t)
	db, release, err := Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	release()
	deadline := time.Now().Add(2 * time.Second)
	for db.Ping() == nil {
		if time.Now().After(deadline) {
			t.Fatal("idle pool was never closed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	again, release2, err := Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer release2()
	if again == db {
		t.Fatal("a closed pool was handed out again")
	}
}

func TestAcquireReopensReplacedDatabase(t *testing.T) {
	dir := newCairnDir(t)
	db, release, err := Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO tags (id, name, created_at) VALUES ('t1', 'old', 'x')`); err != nil {
		t.Fatal(err)
	}
	release()

	// Swap in a different database file, as a restore would.
	other := newCairnDir(t)
	fresh, err := Open(other)
	if err != nil {
		t.Fatal(err)
	}
	_ = fresh.Close()
	path := filepath.Join(dir, dbFileName)
	for _, suffix := range []string{"-wal", "-shm"} {
		_ = os.Remove(path + suffix)
	}
	if err := os.Rename(filepath.Join(other, dbFileName), path); err != nil {
		t.Skipf("cannot replace an open database on this platform: %v", err)
	}

	db2, release2, err := Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer release2()
	var n int
	if err := db2.QueryRow(`SELECT COUNT(*) FROM tags`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("read %d tags from the replaced database; want the new, empty one", n)
	}
}
