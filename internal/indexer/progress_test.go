package indexer

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/Jishnu-Prasad888/Cairn/internal/jobs"
	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
)

func writeTree(t *testing.T, root string, files ...string) {
	t.Helper()
	for _, f := range files {
		p := filepath.Join(root, filepath.FromSlash(f))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(f), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestScanProgressCountsEveryFolder(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, "top.jpg", "a/1.jpg", "a/2.jpg", "a/deep/3.jpg", "b/4.jpg", ".cairn/skip.db")

	p := newScanProgress()
	if _, _, ok := p.Under(""); ok {
		t.Fatal("Under reported totals before the counting walk")
	}
	if err := p.count(context.Background(), root); err != nil {
		t.Fatal(err)
	}
	for folder, want := range map[string]int{"": 5, "a": 3, "a/deep": 1, "b": 1} {
		total, done, ok := p.Under(folder)
		if !ok || total != want || done != 0 {
			t.Errorf("Under(%q) = %d, %d, %v; want %d, 0, true", folder, total, done, ok, want)
		}
	}

	p.fileDone("a/1.jpg")
	p.fileDone("a/deep/3.jpg")
	if total, done, _ := p.Under("a"); total != 3 || done != 2 {
		t.Errorf("Under(a) after two files = %d, %d; want 3, 2", total, done)
	}
	// "a" must not match the sibling prefix "ab".
	p.fileDone("ab/5.jpg")
	if total, _, _ := p.Under("a"); total != 3 {
		t.Errorf("Under(a) counted a sibling folder: total %d", total)
	}
}

func TestFolderScanState(t *testing.T) {
	m := NewIndexManager(slog.New(slog.NewTextHandler(io.Discard, nil)))
	if state, _, _ := m.FolderScanState("lib", "a", 0); state != "" {
		t.Fatalf("no scan running, got state %q", state)
	}

	p := newScanProgress()
	m.setScanProgress("lib", p)
	if state, _, _ := m.FolderScanState("lib", "a", 0); state != FolderWaiting {
		t.Errorf("counting, nothing indexed: got %q, want waiting", state)
	}
	if state, _, _ := m.FolderScanState("lib", "a", 4); state != "" {
		t.Errorf("counting, folder already indexed: got %q, want none", state)
	}

	root := t.TempDir()
	writeTree(t, root, "a/1.jpg", "a/2.jpg")
	if err := p.count(context.Background(), root); err != nil {
		t.Fatal(err)
	}
	if state, total, _ := m.FolderScanState("lib", "a", 0); state != FolderWaiting || total != 2 {
		t.Errorf("not reached: got %q total %d, want waiting 2", state, total)
	}
	p.fileDone("a/1.jpg")
	if state, _, scanned := m.FolderScanState("lib", "a", 1); state != FolderScanning || scanned != 1 {
		t.Errorf("half way: got %q scanned %d, want scanning 1", state, scanned)
	}
	// A rescan of a folder whose files are all in the index already.
	if state, _, _ := m.FolderScanState("lib", "a", 2); state != "" {
		t.Errorf("rescan of an indexed folder: got %q, want none", state)
	}
	p.fileDone("a/2.jpg")
	if state, _, _ := m.FolderScanState("lib", "a", 1); state != "" {
		t.Errorf("scanned: got %q, want none", state)
	}
}

func TestProgressTree(t *testing.T) {
	root := t.TempDir()
	cairnDir := filepath.Join(root, ".cairn")
	if err := os.MkdirAll(cairnDir, 0o755); err != nil {
		t.Fatal(err)
	}
	ldb, err := librarydb.OpenDB(cairnDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ldb.Close() })
	writeTree(t, root, "a/1.jpg", "a/2.jpg", "b/3.jpg")

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	m := NewIndexManager(logger)
	ctx := context.Background()

	if _, err := NewScanner(NewStateStore(ldb.DB()), logger).Scan(ctx, "lib", root); err != nil {
		t.Fatal(err)
	}
	q := jobs.NewQueue(ldb.DB(), logger)
	if _, err := q.Enqueue(ctx, jobs.KindProcessMedia, map[string]any{"rel_path": "a/1.jpg"}); err != nil {
		t.Fatal(err)
	}

	prog, err := m.Progress(ctx, "lib", root)
	if err != nil {
		t.Fatal(err)
	}
	if prog.Scan != nil {
		t.Errorf("no scan running, got %+v", prog.Scan)
	}
	if prog.Root.Files != 3 || prog.MediaPending != 1 {
		t.Errorf("root files %d pending %d, want 3 and 1", prog.Root.Files, prog.MediaPending)
	}
	byName := map[string]*FolderProgress{}
	for _, c := range prog.Root.Children {
		byName[c.Name] = c
	}
	if a := byName["a"]; a == nil || a.Status != FolderProcessing || a.Files != 2 {
		t.Errorf("folder a = %+v, want processing with 2 files", a)
	}
	if b := byName["b"]; b == nil || b.Status != FolderDone {
		t.Errorf("folder b = %+v, want done", b)
	}

	// During a scan the walk's counts are reported instead.
	p := newScanProgress()
	if err := p.count(ctx, root); err != nil {
		t.Fatal(err)
	}
	p.fileDone("a/1.jpg")
	m.setScanProgress("lib", p)
	prog, err = m.Progress(ctx, "lib", root)
	if err != nil {
		t.Fatal(err)
	}
	if prog.Scan == nil || prog.Scan.FilesTotal != 3 || prog.Scan.FilesScanned != 1 {
		t.Fatalf("scan = %+v, want 1 of 3", prog.Scan)
	}
	byName = map[string]*FolderProgress{}
	for _, c := range prog.Root.Children {
		byName[c.Name] = c
	}
	if a := byName["a"]; a.Status != FolderScanning {
		t.Errorf("folder a status %q, want scanning", a.Status)
	}
	if b := byName["b"]; b.Status != FolderWaiting {
		t.Errorf("folder b status %q, want waiting", b.Status)
	}
}

func TestScanFillsProgress(t *testing.T) {
	root := t.TempDir()
	cairnDir := filepath.Join(root, ".cairn")
	if err := os.MkdirAll(cairnDir, 0o755); err != nil {
		t.Fatal(err)
	}
	ldb, err := librarydb.OpenDB(cairnDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ldb.Close() })
	writeTree(t, root, "a/1.jpg", "a/b/2.jpg", "3.jpg")

	sc := NewScanner(NewStateStore(ldb.DB()), slog.New(slog.NewTextHandler(io.Discard, nil)))
	sc.progress = newScanProgress()
	if _, err := sc.Scan(context.Background(), "lib", root); err != nil {
		t.Fatal(err)
	}
	if total, done, ok := sc.progress.Under(""); !ok || total != 3 || done != 3 {
		t.Errorf("after the scan Under(\"\") = %d, %d, %v; want 3, 3, true", total, done, ok)
	}
	if _, current, _, _ := sc.progress.snapshot(); current != "a/b" {
		t.Errorf("current folder %q, want the last one walked, a/b", current)
	}
}
