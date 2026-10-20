package indexer_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/Jishnu-Prasad888/Cairn/internal/indexer"
)

func TestNormalizeIgnoreRules(t *testing.T) {
	root := "/srv/photos"
	got, err := indexer.NormalizeIgnoreRules(root, []indexer.IgnoreRule{
		{Kind: "path", Pattern: "/srv/photos/2019/raw/"},
		{Kind: "path", Pattern: "2019/raw"}, // duplicate once normalized
		{Kind: "extension", Pattern: "*.XMP"},
		{Kind: "extension", Pattern: ".tmp"},
		{Kind: "name", Pattern: " Thumbs.db "},
	})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	want := []indexer.IgnoreRule{
		{Kind: "path", Pattern: "2019/raw"},
		{Kind: "extension", Pattern: "xmp"},
		{Kind: "extension", Pattern: "tmp"},
		{Kind: "name", Pattern: "Thumbs.db"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("rule %d = %v, want %v", i, got[i], want[i])
		}
	}

	for _, bad := range []indexer.IgnoreRule{
		{Kind: "path", Pattern: "/etc/passwd"},
		{Kind: "path", Pattern: "/srv/photos"},
		{Kind: "path", Pattern: "../elsewhere"},
		{Kind: "path", Pattern: ".cairn"},
		{Kind: "extension", Pattern: "a/b"},
		{Kind: "name", Pattern: "dir/name"},
		{Kind: "name", Pattern: "[unclosed"},
		{Kind: "name", Pattern: "   "},
		{Kind: "glob", Pattern: "x"},
	} {
		if _, err := indexer.NormalizeIgnoreRules(root, []indexer.IgnoreRule{bad}); err == nil {
			t.Errorf("rule %v was accepted", bad)
		}
	}
}

func TestScannerHonorsIgnoreRules(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	for _, rel := range []string{
		"keep.jpg",
		"keep.XMP",
		"raw/a.cr2",
		"raw/deep/b.cr2",
		"album/Thumbs.db",
		"album/@eaDir/c.jpg",
		"album/d.jpg",
	} {
		writeFile(t, filepath.Join(root, rel), rel)
	}

	db := newTestDB(t)
	store := indexer.NewStateStore(db.DB())
	scanner := indexer.NewScanner(store, discardLogger())

	// First scan with no rules indexes everything.
	if res, err := scanner.Scan(ctx, "lib", root); err != nil || res.TotalFiles != 7 {
		t.Fatalf("first scan: total %v, err %v", res, err)
	}

	rules, err := indexer.NormalizeIgnoreRules(root, []indexer.IgnoreRule{
		{Kind: "path", Pattern: "raw"},
		{Kind: "extension", Pattern: "xmp"},
		{Kind: "name", Pattern: "thumbs.db"},
		{Kind: "name", Pattern: "@*"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := indexer.SaveIgnoreRules(ctx, db.DB(), rules); err != nil {
		t.Fatal(err)
	}
	loaded, err := indexer.LoadIgnoreRules(ctx, db.DB())
	if err != nil || len(loaded) != len(rules) {
		t.Fatalf("load rules: %v, %v", loaded, err)
	}

	res, err := scanner.Scan(ctx, "lib", root)
	if err != nil {
		t.Fatal(err)
	}
	if res.TotalFiles != 2 || res.Missing != 5 {
		t.Fatalf("scan with rules: total %d missing %d, want 2 and 5", res.TotalFiles, res.Missing)
	}
	for _, rel := range []string{"keep.jpg", "album/d.jpg"} {
		f, err := store.GetByPath(ctx, rel)
		if err != nil || f == nil || f.Status != indexer.StatusPresent {
			t.Errorf("%s: %v, %v; want present", rel, f, err)
		}
	}

	// Removing the rules brings the same records back.
	if err := indexer.SaveIgnoreRules(ctx, db.DB(), nil); err != nil {
		t.Fatal(err)
	}
	res, err = scanner.Scan(ctx, "lib", root)
	if err != nil {
		t.Fatal(err)
	}
	if res.TotalFiles != 7 || res.NewFiles != 0 {
		t.Fatalf("scan after removing rules: total %d new %d, want 7 and 0", res.TotalFiles, res.NewFiles)
	}
}
