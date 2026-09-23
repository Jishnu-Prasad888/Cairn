package httpapi

import (
	"bytes"
	"image"
	"image/jpeg"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/Jishnu-Prasad888/Cairn/internal/crypto"
)

// TestEncryptedThumbnailServesDecryptedJPEG verifies that with at-rest
// encryption enabled the on-demand thumbnail is written sealed (so plaintext
// is not decodable on disk) yet the API still serves a valid decrypted JPEG,
// without ever modifying the original media file.
func TestEncryptedThumbnailServesDecryptedJPEG(t *testing.T) {
	keys := crypto.NewKeys("test at-rest passphrase")
	handler, client, libID, libRoot := newSearchTestServerWithKeys(t, keys)

	// Register a real file on disk and seed its index row so the thumbnail
	// capability check can resolve it.
	srcPath := filepath.Join(libRoot, "sunset.jpg")
	f, err := os.Create(srcPath)
	if err != nil {
		t.Fatal(err)
	}
	img := image.NewRGBA(image.Rect(0, 0, 700, 500))
	if err := jpeg.Encode(f, img, nil); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	origBytes, _ := os.ReadFile(srcPath)

	if err := seedLibraryFile(t, libRoot, "file-thumb-1", "sunset.jpg", 100); err != nil {
		t.Fatalf("seed: %v", err)
	}

	rec := client.roundTrip(t, http.MethodGet,
		"/api/v1/libraries/"+libID+"/files/file-thumb-1/thumbnail", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("thumbnail status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Errorf("content-type = %q, want image/jpeg", ct)
	}
	body := rec.Body.Bytes()
	if !bytes.HasPrefix(body, []byte{0xff, 0xd8, 0xff}) {
		t.Error("served thumbnail is not a JPEG")
	}
	if _, _, err := image.Decode(bytes.NewReader(body)); err != nil {
		t.Errorf("served thumbnail does not decode: %v", err)
	}

	// The artifact on disk is sealed; decoding it directly must fail.
	thumbPath := filepath.Join(libRoot, ".cairn", "thumbs", "file-thumb-1.jpg")
	raw, err := os.ReadFile(thumbPath)
	if err != nil {
		t.Fatalf("read on-disk thumbnail: %v", err)
	}
	if !crypto.IsSealed(raw) {
		t.Error("on-disk thumbnail is not sealed with the at-rest key")
	}
	if _, _, err := image.Decode(bytes.NewReader(raw)); err == nil {
		t.Error("on-disk sealed thumbnail decodes as plaintext JPEG")
	}

	// The original media file is byte-for-byte untouched (ADR-0004).
	afterBytes, _ := os.ReadFile(srcPath)
	if !bytes.Equal(origBytes, afterBytes) {
		t.Error("original media file was modified by thumbnail generation")
	}
	_ = handler
}
