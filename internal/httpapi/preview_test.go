package httpapi

import (
	"image"
	"image/jpeg"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/crypto"
	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
)

// TestPreview covers the viewer's preview: a large photo is served as a
// screen-sized, versioned, cacheable JPEG; a photo that is small already
// answers 404 so the viewer shows the original.
func TestPreview(t *testing.T) {
	_, client, libID, libRoot := newSearchTestServerWithKeys(t, crypto.NewKeys(""))

	write := func(name string, w, h int) {
		f, err := os.Create(filepath.Join(libRoot, name))
		if err != nil {
			t.Fatal(err)
		}
		if err := jpeg.Encode(f, image.NewRGBA(image.Rect(0, 0, w, h)), nil); err != nil {
			t.Fatal(err)
		}
		_ = f.Close()
	}
	write("big.jpg", 3000, 1500)
	write("small.jpg", 640, 480)

	ldb, err := librarydb.Open(filepath.Join(libRoot, ".cairn"))
	if err != nil {
		t.Fatal(err)
	}
	stamp := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	for _, row := range [][2]string{{"big-1", "big.jpg"}, {"small-1", "small.jpg"}} {
		if _, err := ldb.Exec(`INSERT INTO indexed_files
			(id, rel_path, size_bytes, mod_time, media_type, status, first_seen_at, last_seen_at, indexed_at)
			VALUES (?, ?, 1, ?, 'photo', 'present', ?, ?, ?)`, row[0], row[1], stamp, stamp, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	_ = ldb.Close()

	base := "/api/v1/libraries/" + libID + "/files/"
	rec := client.roundTrip(t, http.MethodGet, base+"big-1/preview?v=1", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("preview = %d (%s)", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, max-age=31536000, immutable" {
		t.Errorf("versioned Cache-Control = %q", got)
	}
	cfg, err := jpeg.DecodeConfig(rec.Body)
	if err != nil {
		t.Fatalf("decode preview: %v", err)
	}
	if cfg.Width != 2048 || cfg.Height != 1024 {
		t.Errorf("preview = %dx%d, want 2048x1024", cfg.Width, cfg.Height)
	}

	if rec := client.roundTrip(t, http.MethodGet, base+"small-1/preview?v=1", ""); rec.Code != http.StatusNotFound {
		t.Errorf("small photo preview = %d, want 404", rec.Code)
	}
}
