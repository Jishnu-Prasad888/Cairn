package ml_test

import (
	"context"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
	"github.com/Jishnu-Prasad888/Cairn/internal/ml"
)

// writePNG writes a solid-color PNG to path with the given size.
func writePNG(t *testing.T, path string, w, h int, c color.RGBA) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			img.Set(x, y, c)
		}
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
}

func TestAverageHashDeterministic(t *testing.T) {
	p := ml.AverageHashProvider{}
	if p.Name() == "" {
		t.Error("Name() empty")
	}
	if p.Version() != 1 {
		t.Errorf("Version() = %d, want 1", p.Version())
	}

	a := image.NewRGBA(image.Rect(0, 0, 64, 64))
	for x := 0; x < 64; x++ {
		for y := 0; y < 64; y++ {
			a.Set(x, y, color.RGBA{R: uint8(x * 4), G: uint8(y * 4), B: 120, A: 255})
		}
	}
	s1, err := p.Signature(a)
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}
	s2, err := p.Signature(a)
	if err != nil {
		t.Fatalf("Signature (2nd): %v", err)
	}
	if s1 != s2 {
		t.Errorf("signature not deterministic: %#x vs %#x", s1, s2)
	}
}

func TestStoreLifecycle(t *testing.T) {
	dir := t.TempDir()
	cairnDir := filepath.Join(dir, ".cairn")
	if err := os.MkdirAll(cairnDir, 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := librarydb.Open(cairnDir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = db.Close() }()

	ctx := context.Background()
	// Seed two present files in indexed_files so joins work.
	now := "2026-01-01T00:00:00.000Z"
	files := []struct {
		id, rel string
	}{
		{"f1", "a.jpg"},
		{"f2", "b.png"},
		{"f3", "notes.txt"},
	}
	for _, f := range files {
		if _, err := db.ExecContext(ctx, `
			INSERT INTO indexed_files (id, rel_path, size_bytes, mod_time, status, first_seen_at, last_seen_at, indexed_at)
			VALUES (?, ?, 1, ?, 'present', ?, ?, ?)`, f.id, f.rel, now, now, now, now); err != nil {
			t.Fatalf("seed file: %v", err)
		}
	}

	s := ml.NewStore(db)
	if n, err := s.Count(ctx); err != nil || n != 0 {
		t.Fatalf("Count = %d, %v; want 0", n, err)
	}

	// Nothing needs a signature yet; all three lack one.
	missing, err := s.IDsWithoutSignature(ctx, "average_hash", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(missing) != 3 {
		t.Fatalf("IDsWithoutSignature = %d files, want 3", len(missing))
	}

	// Upsert a signature for f1.
	if err := s.Upsert(ctx, ml.SignatureRecord{
		FileID: "f1", Provider: "average_hash", Version: 1, Signature: 0b101},
	); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.Count(ctx); n != 1 {
		t.Errorf("Count after upsert = %d, want 1", n)
	}
	rec, err := s.Get(ctx, "f1")
	if err != nil {
		t.Fatal(err)
	}
	if rec == nil || rec.Signature != 0b101 || rec.Version != 1 {
		t.Errorf("Get = %+v, want signature 0b101", rec)
	}

	// Only f2/f3 remain unsigned.
	missing, err = s.IDsWithoutSignature(ctx, "average_hash", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(missing) != 2 {
		t.Fatalf("IDsWithoutSignature after upsert = %d, want 2", len(missing))
	}

	// Upsert same file again is idempotent (still one row).
	if err := s.Upsert(ctx, ml.SignatureRecord{
		FileID: "f1", Provider: "average_hash", Version: 1, Signature: 0b111},
	); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.Count(ctx); n != 1 {
		t.Errorf("Count after re-upsert = %d, want 1", n)
	}

	// Signatures for f2/f3; similarity ranking.
	_ = s.Upsert(ctx, ml.SignatureRecord{FileID: "f2", Provider: "average_hash", Version: 1, Signature: 0b101})
	_ = s.Upsert(ctx, ml.SignatureRecord{FileID: "f3", Provider: "average_hash", Version: 1, Signature: 0b000})

	hits, err := s.Similar(ctx, 0b101, 10, "f1")
	if err != nil {
		t.Fatal(err)
	}
	// f2 (0b101) distance 0 beats f3 (0b000) distance 1.
	if len(hits) != 2 {
		t.Fatalf("Similar = %d hits, want 2", len(hits))
	}
	if hits[0].FileID != "f2" || hits[0].Distance != 0 {
		t.Errorf("top hit = %+v, want f2 distance 0", hits[0])
	}
	if hits[1].FileID != "f3" || hits[1].Distance != 2 {
		t.Errorf("second hit = %+v, want f3 distance 2", hits[1])
	}
	if hits[0].Similarity != 1.0 {
		t.Errorf("similarity = %v, want 1.0", hits[0].Similarity)
	}

	// Purge removes everything.
	if err := s.Purge(ctx); err != nil {
		t.Fatalf("Purge: %v", err)
	}
	if n, _ := s.Count(ctx); n != 0 {
		t.Errorf("Count after purge = %d, want 0", n)
	}
}

// managerPassTest runs a realistic pass end-to-end via the manager.
func TestManagerPassAndSimilarity(t *testing.T) {
	root := t.TempDir()
	for i, c := range []color.RGBA{
		{R: 200, G: 10, B: 10, A: 255},
		{R: 200, G: 10, B: 10, A: 255},  // near-duplicate of img0
		{R: 10, G: 200, B: 200, A: 255}, // clearly different
	} {
		writePNG(t, filepath.Join(root, "img"+string(rune('0'+i))+".png"), 96, 96, c)
	}

	cairnDir := filepath.Join(root, ".cairn")
	if err := os.MkdirAll(cairnDir, 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := librarydb.Open(cairnDir)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	now := "2026-01-01T00:00:00.000Z"
	for i := 0; i < 3; i++ {
		rel := "img" + string(rune('0'+i)) + ".png"
		_, err := db.ExecContext(ctx, `
			INSERT INTO indexed_files (id, rel_path, size_bytes, mod_time, status, first_seen_at, last_seen_at, indexed_at)
			VALUES (?, ?, 1, ?, 'present', ?, ?, ?)`,
			"file"+string(rune('0'+i)), rel, now, now, now, now)
		if err != nil {
			t.Fatal(err)
		}
	}
	_ = db.Close()

	m := ml.NewManager(tLog(), ml.Config{Enabled: true, Workers: 2}, ml.AverageHashProvider{})
	n, err := m.Pass(ctx, "lib-1", root)
	if err != nil {
		t.Fatalf("Pass: %v", err)
	}
	if n != 3 {
		t.Errorf("Pass processed %d files, want 3", n)
	}

	// A second pass does nothing (all signed).
	if n, err := m.Pass(ctx, "lib-1", root); err != nil || n != 0 {
		t.Errorf("second Pass = %d, %v; want 0", n, err)
	}

	// The near-duplicate of file0 is the top hit.
	hits, err := m.Similar(ctx, "lib-1", root, "file0", 10)
	if err != nil {
		t.Fatalf("Similar: %v", err)
	}
	if len(hits) != 2 {
		t.Fatalf("Similar = %d hits, want 2", len(hits))
	}
	if hits[0].FileID != "file1" {
		t.Errorf("top similar = %+v, want file1", hits[0])
	}
	// The different image is least similar.
	if hits[1].FileID != "file2" {
		t.Errorf("second similar = %+v, want file2", hits[1])
	}

	// Disabled manager refuses work.
	m2 := ml.NewManager(tLog(), ml.Config{Enabled: false}, ml.AverageHashProvider{})
	if _, err := m2.Pass(ctx, "lib-1", root); err == nil {
		t.Error("Pass on disabled manager: want error")
	}

	// Purge clears signatures.
	if n, err := m.Purge(ctx, "lib-1", root); err != nil || n != 3 {
		t.Errorf("Purge = %d, %v; want 3", n, err)
	}
	if n, err := m.Pass(ctx, "lib-1", root); err != nil || n != 3 {
		t.Errorf("Pass after purge = %d, %v; want 3 (regenerable)", n, err)
	}
}

func tLog() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
