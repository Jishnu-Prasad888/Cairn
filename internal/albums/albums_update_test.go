package albums_test

import (
	"context"
	"errors"
	"testing"

	"github.com/Jishnu-Prasad888/Cairn/internal/albums"
)

func strPtr(s string) *string { return &s }

func TestUpdateRenamesAndDescribes(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	a, err := store.Create(ctx, "Holiday", "")
	if err != nil {
		t.Fatal(err)
	}

	got, err := store.Update(ctx, a.ID, albums.AlbumUpdate{
		Name:        strPtr("Summer 2026"),
		Description: strPtr("By the sea"),
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if got.Name != "Summer 2026" || got.Description != "By the sea" {
		t.Fatalf("got %q / %q", got.Name, got.Description)
	}

	// A nil field is left alone.
	got, err = store.Update(ctx, a.ID, albums.AlbumUpdate{Description: strPtr("")})
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Summer 2026" || got.Description != "" {
		t.Fatalf("partial update changed the wrong fields: %+v", got)
	}
}

func TestUpdateRejectsEmptyName(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	a, _ := store.Create(ctx, "Holiday", "")
	if _, err := store.Update(ctx, a.ID, albums.AlbumUpdate{Name: strPtr("")}); !errors.Is(err, albums.ErrEmptyName) {
		t.Fatalf("want ErrEmptyName, got %v", err)
	}
}

func TestUpdateUnknownAlbum(t *testing.T) {
	store := newTestStore(t)
	if _, err := store.Update(context.Background(), "missing", albums.AlbumUpdate{Name: strPtr("x")}); !errors.Is(err, albums.ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestCoverMustBeInAlbum(t *testing.T) {
	store, files := newTestStoreWithFiles(t)
	ctx := context.Background()
	a, _ := store.Create(ctx, "Holiday", "")
	inside := seedFile(t, files, "beach.jpg")
	outside := seedFile(t, files, "other.jpg")
	if err := store.AddFile(ctx, a.ID, inside); err != nil {
		t.Fatal(err)
	}

	if _, err := store.Update(ctx, a.ID, albums.AlbumUpdate{CoverFileID: &outside}); !errors.Is(err, albums.ErrFileNotInAlbum) {
		t.Fatalf("want ErrFileNotInAlbum, got %v", err)
	}
	got, err := store.Update(ctx, a.ID, albums.AlbumUpdate{CoverFileID: &inside})
	if err != nil {
		t.Fatal(err)
	}
	if got.CoverFileID != inside || got.PreviewFileID != inside {
		t.Fatalf("cover not set: %+v", got)
	}

	// Clearing the cover falls back to the first file.
	got, err = store.Update(ctx, a.ID, albums.AlbumUpdate{CoverFileID: strPtr("")})
	if err != nil {
		t.Fatal(err)
	}
	if got.CoverFileID != "" || got.PreviewFileID != inside {
		t.Fatalf("cleared cover: %+v", got)
	}
}

func TestListReportsCountAndPreview(t *testing.T) {
	store, files := newTestStoreWithFiles(t)
	ctx := context.Background()
	empty, _ := store.Create(ctx, "Empty", "")
	full, _ := store.Create(ctx, "Full", "")
	notes := seedFile(t, files, "notes.txt")
	photo := seedFile(t, files, "beach.jpg")
	// A document first in album order: the photo still previews the album.
	for _, id := range []string{notes, photo} {
		if err := store.AddFile(ctx, full.ID, id); err != nil {
			t.Fatal(err)
		}
	}

	list, err := store.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]*albums.Album{}
	for _, a := range list {
		byID[a.ID] = a
	}
	if got := byID[empty.ID]; got.FileCount != 0 || got.PreviewFileID != "" {
		t.Fatalf("empty album: %+v", got)
	}
	if got := byID[full.ID]; got.FileCount != 2 || got.PreviewFileID != photo {
		t.Fatalf("full album: count %d preview %q, want 2 and %q", got.FileCount, got.PreviewFileID, photo)
	}
}
