package search_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
	"github.com/Jishnu-Prasad888/Cairn/internal/media"
	"github.com/Jishnu-Prasad888/Cairn/internal/search"
)

// --- test helpers ---

// newTestStoreWithMediaStore returns a SearchStore and a FileStore backed by
// the same database so tests can seed indexed_files.
func newTestStoreWithMediaStore(t *testing.T) (*search.SearchStore, *media.FileStore) {
	t.Helper()
	root := t.TempDir()
	cairnDir := filepath.Join(root, ".cairn")
	if err := os.MkdirAll(cairnDir, 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := librarydb.Open(cairnDir)
	if err != nil {
		t.Fatalf("open library db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ss := search.NewSearchStore(db, "lib1")
	fs := media.NewFileStore(db, "lib1")
	return ss, fs
}

func seedFile(t *testing.T, fs *media.FileStore, relPath string) {
	t.Helper()
	err := fs.UpsertFromPath(context.Background(), relPath, 100, time.Now())
	if err != nil {
		t.Fatalf("seed %s: %v", relPath, err)
	}
}

// --- tests ---

func TestSearchEmpty(t *testing.T) {
	ss, fs := newTestStoreWithMediaStore(t)
	ctx := context.Background()

	seedFile(t, fs, "photo.jpg")
	seedFile(t, fs, "video.mp4")
	seedFile(t, fs, "sub/doc.pdf")

	page, err := ss.Search(ctx, search.SearchQuery{})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(page.Results) != 3 {
		t.Errorf("empty query returned %d results, want 3", len(page.Results))
	}
}

func TestSearchTextMatch(t *testing.T) {
	ss, fs := newTestStoreWithMediaStore(t)
	ctx := context.Background()

	seedFile(t, fs, "holiday/beach.jpg")
	seedFile(t, fs, "holiday/mountains.jpg")
	seedFile(t, fs, "work/report.pdf")

	page, err := ss.Search(ctx, search.SearchQuery{Text: "beach"})
	if err != nil {
		t.Fatalf("Search beach: %v", err)
	}
	if len(page.Results) != 1 {
		t.Errorf("text search returned %d results, want 1", len(page.Results))
	}
	if len(page.Results) > 0 && page.Results[0].File.Name != "beach.jpg" {
		t.Errorf("wrong file: got %q, want beach.jpg", page.Results[0].File.Name)
	}
}

func TestSearchTextMatchPartial(t *testing.T) {
	ss, fs := newTestStoreWithMediaStore(t)
	ctx := context.Background()

	seedFile(t, fs, "vacations/beachday.jpg")
	seedFile(t, fs, "vacations/hiking.jpg")

	// Prefix search: "beach" should match "beachday".
	page, err := ss.Search(ctx, search.SearchQuery{Text: "beach"})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(page.Results) != 1 {
		t.Errorf("prefix search returned %d results, want 1", len(page.Results))
	}
}

func TestSearchFolderFilter(t *testing.T) {
	ss, fs := newTestStoreWithMediaStore(t)
	ctx := context.Background()

	seedFile(t, fs, "2022/img1.jpg")
	seedFile(t, fs, "2022/img2.jpg")
	seedFile(t, fs, "2023/img3.jpg")

	page, err := ss.Search(ctx, search.SearchQuery{FolderPath: "2022"})
	if err != nil {
		t.Fatalf("Search with folder: %v", err)
	}
	if len(page.Results) != 2 {
		t.Errorf("folder filter returned %d results, want 2", len(page.Results))
	}
}

func TestSearchPagination(t *testing.T) {
	ss, fs := newTestStoreWithMediaStore(t)
	ctx := context.Background()

	for _, name := range []string{"a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg"} {
		seedFile(t, fs, name)
	}

	page1, err := ss.Search(ctx, search.SearchQuery{Limit: 2})
	if err != nil {
		t.Fatalf("page1: %v", err)
	}
	if len(page1.Results) != 2 {
		t.Fatalf("page1 len = %d, want 2", len(page1.Results))
	}
	if page1.NextCursor == "" {
		t.Error("expected NextCursor for page 1")
	}

	page2, err := ss.Search(ctx, search.SearchQuery{Limit: 2, Cursor: page1.NextCursor})
	if err != nil {
		t.Fatalf("page2: %v", err)
	}
	if len(page2.Results) != 2 {
		t.Fatalf("page2 len = %d, want 2", len(page2.Results))
	}

	// No overlap.
	seen := map[string]bool{}
	for _, r := range page1.Results {
		seen[r.File.ID] = true
	}
	for _, r := range page2.Results {
		if seen[r.File.ID] {
			t.Errorf("overlap: %s appeared in both pages", r.File.ID)
		}
	}
}

func TestSearchDateRange(t *testing.T) {
	ss, fs := newTestStoreWithMediaStore(t)
	ctx := context.Background()

	// Seed 3 files with distinct mtime.
	now := time.Now().UTC().Truncate(time.Second)
	old := now.Add(-48 * time.Hour)
	recent := now.Add(-1 * time.Hour)

	_ = fs.UpsertFromPath(ctx, "old_photo.jpg", 100, old)
	_ = fs.UpsertFromPath(ctx, "recent_photo.jpg", 100, recent)
	_ = fs.UpsertFromPath(ctx, "now_photo.jpg", 100, now)

	// Only files from the last 2 hours.
	page, err := ss.Search(ctx, search.SearchQuery{
		DateFrom: now.Add(-2 * time.Hour),
	})
	if err != nil {
		t.Fatalf("Search with date range: %v", err)
	}
	if len(page.Results) != 2 {
		t.Errorf("date range returned %d results, want 2", len(page.Results))
	}
}

func TestSearchNoResults(t *testing.T) {
	ss, fs := newTestStoreWithMediaStore(t)
	ctx := context.Background()

	seedFile(t, fs, "beach.jpg")

	page, err := ss.Search(ctx, search.SearchQuery{Text: "zzznomatch"})
	if err != nil {
		t.Fatalf("Search no results: %v", err)
	}
	if len(page.Results) != 0 {
		t.Errorf("expected 0 results, got %d", len(page.Results))
	}
	if page.NextCursor != "" {
		t.Error("expected empty NextCursor when no results")
	}
}

func TestSearchDefaultsLimit(t *testing.T) {
	q := search.SearchQuery{}
	q.Defaults()
	if q.Limit != 50 {
		t.Errorf("default limit = %d, want 50", q.Limit)
	}
}

func TestSearchClampsLimit(t *testing.T) {
	q := search.SearchQuery{Limit: 9999}
	q.Defaults()
	if q.Limit != 200 {
		t.Errorf("clamped limit = %d, want 200", q.Limit)
	}
}

func TestSearchResultHasFileMetadata(t *testing.T) {
	ss, fs := newTestStoreWithMediaStore(t)
	ctx := context.Background()

	seedFile(t, fs, "photos/cat.jpg")

	page, err := ss.Search(ctx, search.SearchQuery{Text: "cat"})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(page.Results) == 0 {
		t.Fatal("expected at least one result")
	}
	f := page.Results[0].File
	if f.ID == "" {
		t.Error("result File.ID is empty")
	}
	if f.Name == "" {
		t.Error("result File.Name is empty")
	}
	if f.LibraryID != "lib1" {
		t.Errorf("LibraryID = %q, want lib1", f.LibraryID)
	}
}
