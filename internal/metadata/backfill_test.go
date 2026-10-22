package metadata_test

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/crypto"
	"github.com/Jishnu-Prasad888/Cairn/internal/jobs"
	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
	"github.com/Jishnu-Prasad888/Cairn/internal/metadata"
)

// A library processed before small thumbnails existed catches up in the
// background: files with a thumbnail get the small one and a colour, and one
// whose thumbnail is gone is marked so it is not retried forever.
func TestHandleRenditionsBackfill(t *testing.T) {
	dir := t.TempDir()
	cairnDir := filepath.Join(dir, ".cairn")
	keys := crypto.NewKeys("")
	if err := os.MkdirAll(cairnDir, 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := librarydb.Open(cairnDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()

	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	for _, id := range []string{"has-thumb", "lost-thumb"} {
		if _, err := db.Exec(`INSERT INTO indexed_files
			(id, rel_path, size_bytes, mod_time, media_type, status, first_seen_at, last_seen_at, indexed_at)
			VALUES (?, ?, 1, ?, 'photo', 'present', ?, ?, ?)`, id, id+".jpg", stamp, stamp, stamp, stamp); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO media_metadata (file_id, media_type, has_thumbnail, updated_at)
			VALUES (?, 'photo', 1, ?)`, id, stamp); err != nil {
			t.Fatal(err)
		}
	}
	src := filepath.Join(dir, "has-thumb.jpg")
	makeJPEG(t, src, 640, 480)
	if ok, err := metadata.GenerateThumbnail(src, cairnDir, "has-thumb", keys); err != nil || !ok {
		t.Fatalf("GenerateThumbnail = %v, %v", ok, err)
	}

	ctx := context.Background()
	if pending, err := metadata.PendingRenditions(ctx, db); err != nil || !pending {
		t.Fatalf("PendingRenditions = %v, %v; want true", pending, err)
	}
	p := metadata.NewProcessor(slog.New(slog.NewTextHandler(io.Discard, nil)), keys)
	job := &jobs.Job{ID: "j1", Payload: map[string]any{"cairn_dir": cairnDir}}
	more, err := p.HandleRenditions(metadata.WithDB(ctx, db), job)
	if err != nil || more {
		t.Fatalf("HandleRenditions = %v, %v; want done", more, err)
	}

	colors := map[string]string{}
	rows, err := db.Query(`SELECT file_id, color FROM media_metadata`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id, c string
		if err := rows.Scan(&id, &c); err != nil {
			t.Fatal(err)
		}
		colors[id] = c
	}
	_ = rows.Close()
	if len(colors["has-thumb"]) != 7 {
		t.Errorf("has-thumb colour = %q, want #rrggbb", colors["has-thumb"])
	}
	if colors["lost-thumb"] != "" {
		t.Errorf("lost-thumb colour = %q, want empty (not retried)", colors["lost-thumb"])
	}
	if _, err := metadata.SmallThumbModTime(cairnDir, "has-thumb"); err != nil {
		t.Errorf("small thumbnail not made: %v", err)
	}
	if pending, _ := metadata.PendingRenditions(ctx, db); pending {
		t.Error("still pending after the backfill")
	}
}
