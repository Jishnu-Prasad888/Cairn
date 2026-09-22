package albums_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/albums"
	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
	"github.com/Jishnu-Prasad888/Cairn/internal/media"
)

// --- helpers ---

func newTestStore(t *testing.T) *albums.AlbumStore {
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
	return albums.NewAlbumStore(db, "lib1")
}

func newTestStoreWithFiles(t *testing.T) (*albums.AlbumStore, *media.FileStore) {
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
	return albums.NewAlbumStore(db, "lib1"), media.NewFileStore(db, "lib1")
}

func seedFile(t *testing.T, fs *media.FileStore, relPath string) string {
	t.Helper()
	if err := fs.UpsertFromPath(context.Background(), relPath, 100, time.Now()); err != nil {
		t.Fatalf("seed %s: %v", relPath, err)
	}
	f, err := fs.GetByRelPath(context.Background(), relPath)
	if err != nil {
		t.Fatalf("get seeded file: %v", err)
	}
	return f.ID
}

// --- Create ---

func TestCreateAlbum(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	a, err := store.Create(ctx, "Summer 2023", "Our summer trip")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if a.ID == "" {
		t.Error("ID is empty")
	}
	if a.Name != "Summer 2023" {
		t.Errorf("Name = %q, want Summer 2023", a.Name)
	}
	if a.Description != "Our summer trip" {
		t.Errorf("Description = %q, want Our summer trip", a.Description)
	}
	if a.CreatedAt.IsZero() || a.UpdatedAt.IsZero() {
		t.Error("CreatedAt or UpdatedAt is zero")
	}
}

func TestCreateAlbumWithoutDescription(t *testing.T) {
	store := newTestStore(t)
	a, err := store.Create(context.Background(), "No desc", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if a.Description != "" {
		t.Errorf("Description = %q, want empty", a.Description)
	}
}

func TestCreateAlbumEmptyNameError(t *testing.T) {
	store := newTestStore(t)
	_, err := store.Create(context.Background(), "", "")
	if err == nil {
		t.Error("expected error for empty name")
	}
}

// --- GetByID ---

func TestGetByID(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	created, _ := store.Create(ctx, "Holidays", "")
	got, err := store.GetByID(ctx, created.ID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got.ID != created.ID {
		t.Errorf("ID mismatch")
	}
}

func TestGetByIDNotFound(t *testing.T) {
	store := newTestStore(t)
	_, err := store.GetByID(context.Background(), "ghost")
	if !errors.Is(err, albums.ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

// --- List ---

func TestList(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	if _, err := store.Create(ctx, "Charlie", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Create(ctx, "Alpha", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Create(ctx, "Bravo", ""); err != nil {
		t.Fatal(err)
	}

	as, err := store.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(as) != 3 {
		t.Fatalf("len = %d, want 3", len(as))
	}
	// Should be sorted by name.
	if as[0].Name != "Alpha" || as[1].Name != "Bravo" || as[2].Name != "Charlie" {
		t.Errorf("unexpected order: %v", func() []string {
			names := make([]string, len(as))
			for i, a := range as {
				names[i] = a.Name
			}
			return names
		}())
	}
}

func TestListEmpty(t *testing.T) {
	store := newTestStore(t)
	as, err := store.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(as) != 0 {
		t.Errorf("expected 0 albums, got %d", len(as))
	}
}

// --- Delete ---

func TestDelete(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	a, _ := store.Create(ctx, "to-delete", "")
	if err := store.Delete(ctx, a.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	_, err := store.GetByID(ctx, a.ID)
	if !errors.Is(err, albums.ErrNotFound) {
		t.Errorf("expected ErrNotFound after delete, got %v", err)
	}
}

func TestDeleteNotFound(t *testing.T) {
	store := newTestStore(t)
	err := store.Delete(context.Background(), "ghost")
	if !errors.Is(err, albums.ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

// --- AddFile / RemoveFile ---

func TestAddRemoveFile(t *testing.T) {
	store, fs := newTestStoreWithFiles(t)
	ctx := context.Background()

	fileID := seedFile(t, fs, "photo.jpg")
	a, _ := store.Create(ctx, "My Album", "")

	if err := store.AddFile(ctx, a.ID, fileID); err != nil {
		t.Fatalf("AddFile: %v", err)
	}

	files, err := store.ListFiles(ctx, a.ID)
	if err != nil {
		t.Fatalf("ListFiles: %v", err)
	}
	if len(files) != 1 {
		t.Fatalf("len = %d, want 1", len(files))
	}
	if files[0].ID != fileID {
		t.Errorf("file ID mismatch: %q != %q", files[0].ID, fileID)
	}

	if err := store.RemoveFile(ctx, a.ID, fileID); err != nil {
		t.Fatalf("RemoveFile: %v", err)
	}

	files2, _ := store.ListFiles(ctx, a.ID)
	if len(files2) != 0 {
		t.Errorf("expected 0 files after remove, got %d", len(files2))
	}
}

func TestAddFileIdempotent(t *testing.T) {
	store, fs := newTestStoreWithFiles(t)
	ctx := context.Background()

	fileID := seedFile(t, fs, "photo.jpg")
	a, _ := store.Create(ctx, "Album", "")

	if err := store.AddFile(ctx, a.ID, fileID); err != nil {
		t.Fatalf("first AddFile: %v", err)
	}
	if err := store.AddFile(ctx, a.ID, fileID); err != nil { // second add is no-op
		t.Fatal(err)
	}

	files, _ := store.ListFiles(ctx, a.ID)
	if len(files) != 1 {
		t.Errorf("expected 1 file after double add, got %d", len(files))
	}
}

func TestRemoveFileNotInAlbum(t *testing.T) {
	store, fs := newTestStoreWithFiles(t)
	ctx := context.Background()

	fileID := seedFile(t, fs, "photo.jpg")
	a, _ := store.Create(ctx, "Album", "")

	err := store.RemoveFile(ctx, a.ID, fileID)
	if !errors.Is(err, albums.ErrFileNotInAlbum) {
		t.Errorf("expected ErrFileNotInAlbum, got %v", err)
	}
}

// --- ListFiles ---

func TestListFilesOrder(t *testing.T) {
	store, fs := newTestStoreWithFiles(t)
	ctx := context.Background()

	f1 := seedFile(t, fs, "a.jpg")
	f2 := seedFile(t, fs, "b.jpg")
	f3 := seedFile(t, fs, "c.jpg")
	a, _ := store.Create(ctx, "Ordered", "")

	// Add in order; positions should be 0, 1, 2.
	if err := store.AddFile(ctx, a.ID, f1); err != nil {
		t.Fatal(err)
	}
	if err := store.AddFile(ctx, a.ID, f2); err != nil {
		t.Fatal(err)
	}
	if err := store.AddFile(ctx, a.ID, f3); err != nil {
		t.Fatal(err)
	}

	files, err := store.ListFiles(ctx, a.ID)
	if err != nil {
		t.Fatalf("ListFiles: %v", err)
	}
	if len(files) != 3 {
		t.Fatalf("len = %d, want 3", len(files))
	}
	if files[0].ID != f1 || files[1].ID != f2 || files[2].ID != f3 {
		t.Errorf("order is wrong")
	}
}

func TestListFilesEmpty(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	a, _ := store.Create(ctx, "Empty", "")
	files, err := store.ListFiles(ctx, a.ID)
	if err != nil {
		t.Fatalf("ListFiles: %v", err)
	}
	if len(files) != 0 {
		t.Errorf("expected 0 files, got %d", len(files))
	}
}

// --- cascade delete ---

func TestDeleteAlbumCascades(t *testing.T) {
	store, fs := newTestStoreWithFiles(t)
	ctx := context.Background()

	fileID := seedFile(t, fs, "photo.jpg")
	a, _ := store.Create(ctx, "cascade-album", "")
	store.AddFile(ctx, a.ID, fileID)

	// Delete the album; album_files rows should be gone.
	if err := store.Delete(ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	// After album deletion, creating a new album shouldn't see old files.
	a2, _ := store.Create(ctx, "new-album", "")
	files, _ := store.ListFiles(ctx, a2.ID)
	if len(files) != 0 {
		t.Errorf("expected 0 files in new album, got %d", len(files))
	}
}
