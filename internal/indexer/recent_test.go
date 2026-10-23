package indexer_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/indexer"
	"github.com/Jishnu-Prasad888/Cairn/internal/media"
)

// An old photo moved to another folder with a file manager that gives it a
// fresh modification time is not "recently added": it keeps the date it
// joined the library, and a photo that really is new stays ahead of it.
// That holds for a photo Cairn wrote itself (an upload, stored without a
// hash) too.
func TestMovedFileIsNotRecentlyAdded(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db := newTestDB(t)
	scanner := indexer.NewScanner(indexer.NewStateStore(db.DB()), discardLogger())
	files := media.NewFileStore(db.DB(), "lib1")
	old := time.Date(2019, 6, 1, 12, 0, 0, 0, time.UTC)

	writeFile(t, filepath.Join(root, "2019", "beach.jpg"), "an old beach photo")
	if err := os.Chtimes(filepath.Join(root, "2019", "beach.jpg"), old, old); err != nil {
		t.Fatal(err)
	}
	// Uploaded through Cairn: indexed straight away, without a hash.
	writeFile(t, filepath.Join(root, "uploads", "cat.jpg"), "an uploaded cat photo")
	if err := os.Chtimes(filepath.Join(root, "uploads", "cat.jpg"), old, old); err != nil {
		t.Fatal(err)
	}
	if err := files.UpsertFromPath(ctx, "uploads/cat.jpg", 21, old); err != nil {
		t.Fatal(err)
	}
	if _, err := scanner.Scan(ctx, "lib1", root); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1100 * time.Millisecond) // added_at has whole seconds

	writeFile(t, filepath.Join(root, "new.jpg"), "a photo taken today")
	if _, err := scanner.Scan(ctx, "lib1", root); err != nil {
		t.Fatal(err)
	}

	// Move both old photos the way a file manager might: the time is reset.
	later := time.Now().Add(time.Hour)
	for from, to := range map[string]string{
		"2019/beach.jpg":  "archive/beach.jpg",
		"uploads/cat.jpg": "pets/cat.jpg",
	} {
		dst := filepath.Join(root, filepath.FromSlash(to))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(filepath.Join(root, filepath.FromSlash(from)), dst); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(dst, later, later); err != nil {
			t.Fatal(err)
		}
	}
	res, err := scanner.Scan(ctx, "lib1", root)
	if err != nil {
		t.Fatal(err)
	}
	if res.Moved != 2 {
		t.Errorf("moved = %d, want 2 (both recognised as moves, not new files)", res.Moved)
	}
	// The next scan records the new modification times.
	if _, err := scanner.Scan(ctx, "lib1", root); err != nil {
		t.Fatal(err)
	}

	page, err := files.List(ctx, media.ListOptions{Sort: media.SortByAdded, Order: media.SortDesc, Recursive: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Files) != 3 || page.Files[0].RelPath != "new.jpg" {
		var got []string
		for _, f := range page.Files {
			got = append(got, f.RelPath)
		}
		t.Fatalf("recently added = %v; want new.jpg first", got)
	}
	byMod, err := files.List(ctx, media.ListOptions{Sort: media.SortByModTime, Order: media.SortDesc, Recursive: true})
	if err != nil {
		t.Fatal(err)
	}
	if byMod.Files[0].RelPath == "new.jpg" {
		t.Error("by modification time the moved photos should come first (that was the bug)")
	}
}
