package librarydb_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
)

func TestOpenCreatesAndMigrates(t *testing.T) {
	cairnDir := filepath.Join(t.TempDir(), ".cairn")
	if err := os.MkdirAll(cairnDir, 0o755); err != nil {
		t.Fatal(err)
	}

	pool, err := librarydb.Open(cairnDir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = pool.Close() }()

	// indexed_files table must exist.
	var name string
	if err := pool.QueryRow(
		`SELECT name FROM sqlite_master WHERE type='table' AND name='indexed_files'`,
	).Scan(&name); err != nil {
		t.Fatalf("indexed_files table missing: %v", err)
	}

	// index_jobs table must exist.
	if err := pool.QueryRow(
		`SELECT name FROM sqlite_master WHERE type='table' AND name='index_jobs'`,
	).Scan(&name); err != nil {
		t.Fatalf("index_jobs table missing: %v", err)
	}
}

func TestOpenDBWrapper(t *testing.T) {
	cairnDir := filepath.Join(t.TempDir(), ".cairn")
	if err := os.MkdirAll(cairnDir, 0o755); err != nil {
		t.Fatal(err)
	}

	db, err := librarydb.OpenDB(cairnDir)
	if err != nil {
		t.Fatalf("OpenDB: %v", err)
	}
	if db.DB() == nil {
		t.Error("DB() returned nil")
	}
	if err := db.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}
}

func TestOpenIdempotent(t *testing.T) {
	cairnDir := filepath.Join(t.TempDir(), ".cairn")
	if err := os.MkdirAll(cairnDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Opening the same database twice is idempotent (migrations re-run safely).
	for i := 0; i < 3; i++ {
		pool, err := librarydb.Open(cairnDir)
		if err != nil {
			t.Fatalf("Open #%d: %v", i+1, err)
		}
		_ = pool.Close()
	}
}
