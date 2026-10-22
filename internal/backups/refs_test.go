package backups

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// noLinkTarget hides Link, like FTP, SMB or an exFAT USB drive.
type noLinkTarget struct{ inner Target }

func (t noLinkTarget) MkdirAll(p string) error                 { return t.inner.MkdirAll(p) }
func (t noLinkTarget) Create(p string) (io.WriteCloser, error) { return t.inner.Create(p) }
func (t noLinkTarget) Open(p string) (io.ReadCloser, error)    { return t.inner.Open(p) }
func (t noLinkTarget) Size(p string) (int64, error)            { return t.inner.Size(p) }
func (t noLinkTarget) Remove(p string) error                   { return t.inner.Remove(p) }
func (t noLinkTarget) RemoveAll(p string) error                { return t.inner.RemoveAll(p) }
func (t noLinkTarget) Close() error                            { return t.inner.Close() }

// TestIncrementalWithoutHardLinksReferencesAndPrunes covers destinations that
// cannot hard-link: unchanged files are referenced rather than re-copied, a
// pruned backup keeps exactly the files newer ones still point at, and it is
// removed once nothing does.
func TestIncrementalWithoutHardLinksReferencesAndPrunes(t *testing.T) {
	pool, serverPath := tempServerDB(t)
	ctx := context.Background()
	root := filepath.Join(t.TempDir(), "november")
	lib := registerLibrary(t, newLibraryManager(pool), root)
	dir := filepath.Join(t.TempDir(), "backups")

	m := newManager(t, pool, serverPath, dir, "", 1)
	m.open = func(ctx context.Context, d Destination, h func(string)) (Target, error) {
		tgt, err := openTarget(ctx, d, h)
		if err != nil {
			return nil, err
		}
		return noLinkTarget{tgt}, nil
	}

	first, err := m.Run(ctx)
	if err != nil || first.Status != StatusCompleted {
		t.Fatalf("first run: %v %+v", err, first)
	}
	time.Sleep(1100 * time.Millisecond) // distinct folder names
	second, err := m.Run(ctx)
	if err != nil || second.Status != StatusCompleted {
		t.Fatalf("second run: %v %+v", err, second)
	}
	if second.FilesSkipped != 1 {
		t.Fatalf("files skipped = %d, want 1", second.FilesSkipped)
	}

	rel := filepath.Join("libraries", lib.ID, "files", "holiday", "beach.jpg")
	if _, err := os.Stat(filepath.Join(second.Destination, rel)); err == nil {
		t.Fatal("unchanged file was copied into the new backup")
	}
	mf, err := readManifest(second.Destination, nil)
	if err != nil {
		t.Fatal(err)
	}
	if ref := mf.Libraries[0].Files[0].Ref; ref != filepath.Base(first.Destination) {
		t.Fatalf("ref = %q, want %q", ref, filepath.Base(first.Destination))
	}

	// Keep=1: the first backup is pruned but its referenced media stays;
	// its databases go.
	old, _ := m.Get(ctx, first.ID)
	if old.Status != StatusPruned || !old.KeptForRefs {
		t.Fatalf("first record = %s kept=%v, want pruned and kept for refs", old.Status, old.KeptForRefs)
	}
	if _, err := os.Stat(filepath.Join(first.Destination, rel)); err != nil {
		t.Fatalf("referenced file was pruned: %v", err)
	}
	if _, err := os.Stat(filepath.Join(first.Destination, "server", "cairn.db")); err == nil {
		t.Fatal("unreferenced payload survived pruning")
	}

	// Restoring the newer backup reads through the reference.
	out := t.TempDir()
	if _, err := m.Restore(ctx, second.ID, out); err != nil {
		t.Fatalf("restore: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(out, rel))
	if err != nil || string(got) != "jpeg-bytes-that-are-descriptive-enough" {
		t.Fatalf("restored media = %q, %v", got, err)
	}
	if v, err := m.Verify(ctx, second.ID); err != nil || v.VerifyStatus != VerifyOK {
		t.Fatalf("verify through reference: %v %+v", err, v)
	}

	// Change the file: the third backup copies it fresh, the second is
	// pruned, and the first is no longer referenced by anything.
	media := filepath.Join(root, "holiday", "beach.jpg")
	if err := os.WriteFile(media, []byte("a new edit of the photo"), 0o644); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Hour)
	_ = os.Chtimes(media, future, future)
	time.Sleep(1100 * time.Millisecond)
	third, err := m.Run(ctx)
	if err != nil || third.Status != StatusCompleted {
		t.Fatalf("third run: %v %+v", err, third)
	}
	if _, err := os.Stat(first.Destination); !os.IsNotExist(err) {
		t.Fatalf("unreferenced first backup still on disk: %v", err)
	}
	if _, err := os.Stat(second.Destination); !os.IsNotExist(err) {
		t.Fatalf("second backup not pruned: %v", err)
	}
	if old, _ := m.Get(ctx, first.ID); old.KeptForRefs {
		t.Fatal("first record still marked kept for refs")
	}
}

// TestRestoreRejectsUnsafeReference makes sure a tampered ref cannot point a
// restore outside the backup destination.
func TestRestoreRejectsUnsafeReference(t *testing.T) {
	pool, serverPath := tempServerDB(t)
	registerLibrary(t, newLibraryManager(pool), filepath.Join(t.TempDir(), "oscar"))
	m := newManager(t, pool, serverPath, filepath.Join(t.TempDir(), "b"), "", 4)
	rec, err := m.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	mf, err := readManifest(rec.Destination, nil)
	if err != nil {
		t.Fatal(err)
	}
	mf.Libraries[0].Files[0].Ref = "../../etc"
	if err := writeManifest(rec.Destination, mf, false, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Restore(context.Background(), rec.ID, t.TempDir()); err == nil {
		t.Fatal("restore followed an unsafe reference")
	}
}
