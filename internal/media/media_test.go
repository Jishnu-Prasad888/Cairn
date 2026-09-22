package media_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
	"github.com/Jishnu-Prasad888/Cairn/internal/media"
)

// --- helpers ---

func newTestStore(t *testing.T) (*media.FileStore, string) {
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
	return media.NewFileStore(db, "lib1"), root
}

func newTestService(t *testing.T) (*media.Service, *media.FileStore, string) {
	t.Helper()
	store, root := newTestStore(t)
	svc := media.NewService(store, root)
	return svc, store, root
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func seedFile(t *testing.T, store *media.FileStore, root, relPath string) {
	t.Helper()
	abs := filepath.Join(root, filepath.FromSlash(relPath))
	writeFile(t, abs, "content of "+relPath)
	info, err := os.Stat(abs)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertFromPath(context.Background(), relPath, info.Size(), info.ModTime()); err != nil {
		t.Fatalf("seed %s: %v", relPath, err)
	}
}

// --- DetectMediaType ---

func TestDetectMediaType(t *testing.T) {
	cases := []struct {
		path string
		want media.MediaType
	}{
		{"photo.jpg", media.MediaTypePhoto},
		{"photo.JPEG", media.MediaTypePhoto},
		{"video.mp4", media.MediaTypeVideo},
		{"audio.mp3", media.MediaTypeAudio},
		{"doc.pdf", media.MediaTypeDocument},
		{"archive.zip", media.MediaTypeOther},
		{"noext", media.MediaTypeOther},
	}
	for _, tc := range cases {
		got := media.DetectMediaType(tc.path)
		if got != tc.want {
			t.Errorf("DetectMediaType(%q) = %q, want %q", tc.path, got, tc.want)
		}
	}
}

// --- SafeRelPath ---

func TestSafeRelPath(t *testing.T) {
	ok := []string{"photo.jpg", "2022/img.jpg", "a/b/c.mp4"}
	for _, p := range ok {
		if _, err := media.SafeRelPath(p); err != nil {
			t.Errorf("SafeRelPath(%q) unexpected error: %v", p, err)
		}
	}
	bad := []string{"", "../escape.jpg", "/absolute.jpg", "a/../../escape"}
	for _, p := range bad {
		if _, err := media.SafeRelPath(p); err == nil {
			t.Errorf("SafeRelPath(%q) expected error", p)
		}
	}
}

// --- FileStore listing ---

func TestListFiles(t *testing.T) {
	store, root := newTestStore(t)
	ctx := context.Background()

	seedFile(t, store, root, "a.jpg")
	seedFile(t, store, root, "b.mp4")
	seedFile(t, store, root, "sub/c.png")

	// Root-level only.
	page, err := store.List(ctx, media.ListOptions{})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(page.Files) != 2 {
		t.Errorf("root files = %d, want 2", len(page.Files))
	}

	// Recursive — all 3.
	page, err = store.List(ctx, media.ListOptions{Recursive: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Files) != 3 {
		t.Errorf("recursive files = %d, want 3", len(page.Files))
	}
}

func TestListFilesSortByName(t *testing.T) {
	store, root := newTestStore(t)
	ctx := context.Background()
	for _, name := range []string{"c.jpg", "a.jpg", "b.jpg"} {
		seedFile(t, store, root, name)
	}
	page, err := store.List(ctx, media.ListOptions{Sort: media.SortByName, Order: media.SortAsc})
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, len(page.Files))
	for i, f := range page.Files {
		names[i] = f.Name
	}
	if names[0] != "a.jpg" || names[1] != "b.jpg" || names[2] != "c.jpg" {
		t.Errorf("sort order = %v", names)
	}
}

func TestListFilesPagination(t *testing.T) {
	store, root := newTestStore(t)
	ctx := context.Background()
	for _, name := range []string{"a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg"} {
		seedFile(t, store, root, name)
	}

	// Page 1: limit=2
	page1, err := store.List(ctx, media.ListOptions{Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(page1.Files) != 2 {
		t.Fatalf("page1 len = %d, want 2", len(page1.Files))
	}
	if page1.NextCursor == "" {
		t.Error("expected NextCursor for page 1")
	}

	// Page 2: cursor from page1
	page2, err := store.List(ctx, media.ListOptions{Limit: 2, Cursor: page1.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(page2.Files) != 2 {
		t.Fatalf("page2 len = %d, want 2", len(page2.Files))
	}

	// No overlap between pages.
	seen := map[string]bool{}
	for _, f := range page1.Files {
		seen[f.RelPath] = true
	}
	for _, f := range page2.Files {
		if seen[f.RelPath] {
			t.Errorf("overlap: %s appeared in both pages", f.RelPath)
		}
	}
}

func TestListFilesFilterByFolder(t *testing.T) {
	store, root := newTestStore(t)
	ctx := context.Background()
	seedFile(t, store, root, "2022/jan.jpg")
	seedFile(t, store, root, "2022/feb.jpg")
	seedFile(t, store, root, "2023/mar.jpg")

	page, err := store.List(ctx, media.ListOptions{FolderPath: "2022", Recursive: false})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Files) != 2 {
		t.Errorf("folder filter = %d files, want 2", len(page.Files))
	}
}

// --- Upload ---

func TestUpload(t *testing.T) {
	svc, store, _ := newTestService(t)
	ctx := context.Background()

	content := "hello upload content"
	f, err := svc.WriteUpload(ctx, "uploads/new.txt", strings.NewReader(content))
	if err != nil {
		t.Fatalf("WriteUpload: %v", err)
	}
	if f.Name != "new.txt" {
		t.Errorf("name = %q, want new.txt", f.Name)
	}
	if f.SizeBytes != int64(len(content)) {
		t.Errorf("size = %d, want %d", f.SizeBytes, len(content))
	}

	// File must be indexed.
	got, err := store.GetByRelPath(ctx, "uploads/new.txt")
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Error("uploaded file not found in index")
	}
}

func TestUploadRejectsExisting(t *testing.T) {
	svc, store, root := newTestService(t)
	ctx := context.Background()
	seedFile(t, store, root, "exists.jpg")

	_, err := svc.WriteUpload(ctx, "exists.jpg", strings.NewReader("data"))
	if err == nil {
		t.Error("expected ErrAlreadyExists")
	}
}

func TestUploadPathTraversalRejected(t *testing.T) {
	svc, _, _ := newTestService(t)
	_, err := svc.WriteUpload(context.Background(), "../escape.txt", strings.NewReader("x"))
	if err == nil {
		t.Error("expected path traversal error")
	}
}

// --- Rename ---

func TestRename(t *testing.T) {
	svc, store, root := newTestService(t)
	ctx := context.Background()
	seedFile(t, store, root, "old.jpg")

	updated, err := svc.Rename(ctx, "old.jpg", "new.jpg")
	if err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if updated.Name != "new.jpg" {
		t.Errorf("name = %q, want new.jpg", updated.Name)
	}
	// Old path gone from index.
	f, _ := store.GetByRelPath(ctx, "old.jpg")
	if f != nil {
		t.Error("old path still in index after rename")
	}
}

// --- Move ---

func TestMove(t *testing.T) {
	svc, store, root := newTestService(t)
	ctx := context.Background()
	seedFile(t, store, root, "src/photo.jpg")

	updated, err := svc.Move(ctx, "src/photo.jpg", "dst/photo.jpg")
	if err != nil {
		t.Fatalf("Move: %v", err)
	}
	if updated.RelPath != "dst/photo.jpg" {
		t.Errorf("rel_path = %q, want dst/photo.jpg", updated.RelPath)
	}
	f, _ := store.GetByRelPath(ctx, "src/photo.jpg")
	if f != nil {
		t.Error("old path still in index after move")
	}
}

// --- Copy ---

func TestCopy(t *testing.T) {
	svc, store, root := newTestService(t)
	ctx := context.Background()
	seedFile(t, store, root, "original.jpg")

	copied, err := svc.Copy(ctx, "original.jpg", "copy.jpg")
	if err != nil {
		t.Fatalf("Copy: %v", err)
	}
	if copied.RelPath != "copy.jpg" {
		t.Errorf("rel_path = %q, want copy.jpg", copied.RelPath)
	}
	// Both files should exist on disk.
	if _, err := os.Stat(filepath.Join(root, "original.jpg")); err != nil {
		t.Error("original missing after copy")
	}
	if _, err := os.Stat(filepath.Join(root, "copy.jpg")); err != nil {
		t.Error("copy not on disk")
	}
	// Both in index.
	orig, _ := store.GetByRelPath(ctx, "original.jpg")
	if orig == nil {
		t.Error("original not in index")
	}
}

// --- Delete (trash) and Restore ---

func TestDeleteAndRestore(t *testing.T) {
	svc, store, root := newTestService(t)
	ctx := context.Background()
	seedFile(t, store, root, "photo.jpg")

	// Soft delete.
	if err := svc.Delete(ctx, "photo.jpg", "user1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	f, _ := store.GetByRelPath(ctx, "photo.jpg")
	if f == nil {
		t.Fatal("file removed from index; should be kept as deleted")
	}
	if f.Status != media.FileStatusDeleted {
		t.Errorf("status = %q, want deleted", f.Status)
	}
	// File moved to trash on disk.
	if _, err := os.Stat(filepath.Join(root, "photo.jpg")); err == nil {
		t.Error("original file still at original path after delete")
	}

	// Restore.
	restored, err := svc.Restore(ctx, f.ID)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if restored.Status != media.FileStatusPresent {
		t.Errorf("restored status = %q, want present", restored.Status)
	}
	if _, err := os.Stat(filepath.Join(root, "photo.jpg")); err != nil {
		t.Error("file not back at original path after restore")
	}
}

// --- Permanent delete ---

func TestPermanentDelete(t *testing.T) {
	svc, store, root := newTestService(t)
	ctx := context.Background()
	seedFile(t, store, root, "trash_me.jpg")

	if err := svc.Delete(ctx, "trash_me.jpg", ""); err != nil {
		t.Fatal(err)
	}
	f, _ := store.GetByRelPath(ctx, "trash_me.jpg")

	if err := svc.PermanentDelete(ctx, f.ID); err != nil {
		t.Fatalf("PermanentDelete: %v", err)
	}
	// Row gone from index.
	gone, _ := store.GetByID(ctx, f.ID)
	if gone != nil {
		t.Error("file still in index after permanent delete")
	}
}

// --- Original file invariant ---

func TestDownloadDoesNotModifyFile(t *testing.T) {
	svc, store, root := newTestService(t)
	ctx := context.Background()
	content := "original video bytes — must never change"
	seedFile(t, store, root, "video.mp4")
	// Write actual content so hash is stable.
	if err := os.WriteFile(filepath.Join(root, "video.mp4"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(filepath.Join(root, "video.mp4"))
	sizeBefore := info.Size()
	mtimeBefore := info.ModTime()

	fh, _, err := svc.OpenFile(ctx, "video.mp4")
	if err != nil {
		t.Fatalf("OpenFile: %v", err)
	}
	_ = fh.Close()

	info2, _ := os.Stat(filepath.Join(root, "video.mp4"))
	if info2.Size() != sizeBefore {
		t.Errorf("size changed: %d → %d", sizeBefore, info2.Size())
	}
	if !info2.ModTime().Equal(mtimeBefore) {
		t.Errorf("mtime changed after open")
	}
	_ = time.Now() // silence unused import
}
