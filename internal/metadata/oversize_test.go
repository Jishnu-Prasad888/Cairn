package metadata_test

import (
	"bytes"
	"image"
	"image/jpeg"
	"os"
	"path/filepath"
	"testing"

	"github.com/Jishnu-Prasad888/Cairn/internal/crypto"
	"github.com/Jishnu-Prasad888/Cairn/internal/metadata"
	"github.com/Jishnu-Prasad888/Cairn/internal/safeimage"
)

// A photo past safeimage's pixel cap, as a 108 MP phone camera makes, still
// gets a thumbnail and a preview: ffmpeg decodes it instead of Go.
func TestOversizedPhotoGetsRenditions(t *testing.T) {
	if !metadata.VideoFramesAvailable() {
		t.Skip("ffmpeg not installed")
	}
	// 9000×6000 = 54 MP, just past the cap. Grey keeps the encode quick.
	const w, h = 9000, 6000
	if w*h <= safeimage.MaxPixels {
		t.Fatalf("test photo %dx%d is within the cap", w, h)
	}
	src := filepath.Join(t.TempDir(), "big.jpg")
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, image.NewGray(image.Rect(0, 0, w, h)), &jpeg.Options{Quality: 50}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(src, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	cairnDir := filepath.Join(t.TempDir(), ".cairn")
	keys := crypto.NewKeys("")

	ok, err := metadata.GenerateThumbnail(src, cairnDir, "big", keys)
	if err != nil || !ok {
		t.Fatalf("GenerateThumbnail = %v, %v; want made", ok, err)
	}
	data, _, err := metadata.ReadThumb(cairnDir, "big", keys)
	if err != nil {
		t.Fatalf("ReadThumb: %v", err)
	}
	assertJPEGSize(t, "thumbnail", data, metadata.ThumbnailSize, metadata.ThumbnailSize*h/w)

	ok, err = metadata.GeneratePreview(src, cairnDir, "big", keys)
	if err != nil || !ok {
		t.Fatalf("GeneratePreview = %v, %v; want made", ok, err)
	}
	data, _, err = metadata.ReadPreview(cairnDir, "big", keys)
	if err != nil {
		t.Fatalf("ReadPreview: %v", err)
	}
	assertJPEGSize(t, "preview", data, metadata.PreviewSize, metadata.PreviewSize*h/w)
}

func assertJPEGSize(t *testing.T, what string, data []byte, wantW, wantH int) {
	t.Helper()
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decode %s: %v", what, err)
	}
	// ffmpeg rounds the short side to an even number of pixels.
	if format != "jpeg" || cfg.Width != wantW || cfg.Height < wantH-1 || cfg.Height > wantH+1 {
		t.Errorf("%s = %s %dx%d, want jpeg %dx%d", what, format, cfg.Width, cfg.Height, wantW, wantH)
	}
}
