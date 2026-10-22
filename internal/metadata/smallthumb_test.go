package metadata_test

import (
	"errors"
	"image"
	"image/color"
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/crypto"
	"github.com/Jishnu-Prasad888/Cairn/internal/metadata"
)

func TestMakeSmallThumb(t *testing.T) {
	dir := t.TempDir()
	cairnDir := filepath.Join(dir, ".cairn")
	src := filepath.Join(dir, "photo.jpg")
	makeJPEG(t, src, 1200, 900)
	keys := crypto.NewKeys("")

	if ok, err := metadata.GenerateThumbnail(src, cairnDir, "f1", keys); err != nil || !ok {
		t.Fatalf("GenerateThumbnail = %v, %v", ok, err)
	}
	c, err := metadata.MakeSmallThumb(cairnDir, "f1", keys)
	if err != nil {
		t.Fatalf("MakeSmallThumb: %v", err)
	}
	if !regexp.MustCompile(`^#[0-9a-f]{6}$`).MatchString(c) {
		t.Errorf("colour = %q, want #rrggbb", c)
	}

	f, err := os.Open(metadata.SmallThumbPath(cairnDir, "f1"))
	if err != nil {
		t.Fatalf("small thumbnail not on disk: %v", err)
	}
	cfg, _, err := image.DecodeConfig(f)
	_ = f.Close()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Width != metadata.SmallThumbnailSize || cfg.Height > metadata.SmallThumbnailSize {
		t.Errorf("small thumbnail = %dx%d, want %d on its longer side", cfg.Width, cfg.Height, metadata.SmallThumbnailSize)
	}
	if _, err := metadata.SmallThumbModTime(cairnDir, "f1"); err != nil {
		t.Errorf("fresh small thumbnail reported missing: %v", err)
	}
}

// A small thumbnail older than the full one (remade after an edit), or whose
// full thumbnail is gone, shows earlier content and must be made again.
func TestSmallThumbOutdated(t *testing.T) {
	dir := t.TempDir()
	cairnDir := filepath.Join(dir, ".cairn")
	src := filepath.Join(dir, "photo.jpg")
	makeJPEG(t, src, 800, 600)
	keys := crypto.NewKeys("")
	if _, err := metadata.GenerateSmallThumbnail(src, cairnDir, "f2", keys); err != nil {
		t.Fatal(err)
	}

	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(metadata.SmallThumbPath(cairnDir, "f2"), old, old); err != nil {
		t.Fatal(err)
	}
	if _, err := metadata.SmallThumbModTime(cairnDir, "f2"); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("older small thumbnail: err = %v, want not-exist", err)
	}

	if _, err := metadata.GenerateSmallThumbnail(src, cairnDir, "f2", keys); err != nil {
		t.Fatal(err)
	}
	if _, err := metadata.SmallThumbModTime(cairnDir, "f2"); err != nil {
		t.Errorf("remade small thumbnail: %v", err)
	}

	if err := os.Remove(metadata.ThumbPath(cairnDir, "f2")); err != nil {
		t.Fatal(err)
	}
	if _, err := metadata.SmallThumbModTime(cairnDir, "f2"); err == nil {
		t.Error("small thumbnail without its full thumbnail reported present")
	}
}

func TestAverageColor(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 10, 10))
	for y := 0; y < 10; y++ {
		for x := 0; x < 10; x++ {
			img.Set(x, y, color.RGBA{R: 0x20, G: 0x80, B: 0xf0, A: 0xff})
		}
	}
	if got := metadata.AverageColor(img); got != "#2080f0" {
		t.Errorf("AverageColor = %q, want #2080f0", got)
	}
	// A sub-image reads its own pixels, not its parent's from the origin.
	img.Set(6, 6, color.RGBA{A: 0xff})
	sub := img.SubImage(image.Rect(6, 6, 7, 7))
	if got := metadata.AverageColor(sub); got != "#000000" {
		t.Errorf("sub-image AverageColor = %q, want #000000", got)
	}
}
