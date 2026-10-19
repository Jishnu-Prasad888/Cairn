package httpapi

import (
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/crypto"
	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
	"github.com/Jishnu-Prasad888/Cairn/internal/metadata"
)

// TestThumbnailCaching covers the browser cache contract: a versioned URL is
// cached for good, an unversioned one is revalidated (and answered with 304
// without reading the thumbnail), and a thumbnail older than its file is
// remade rather than served.
func TestThumbnailCaching(t *testing.T) {
	_, client, libID, libRoot := newSearchTestServerWithKeys(t, crypto.NewKeys(""))

	f, err := os.Create(filepath.Join(libRoot, "pic.png"))
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(f, image.NewRGBA(image.Rect(0, 0, 32, 32))); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	fileMod := time.Now().Add(-time.Hour).UTC()
	ldb, err := librarydb.Open(filepath.Join(libRoot, ".cairn"))
	if err != nil {
		t.Fatal(err)
	}
	stamp := fileMod.Format(time.RFC3339Nano)
	if _, err := ldb.Exec(`INSERT INTO indexed_files
		(id, rel_path, size_bytes, mod_time, media_type, status, first_seen_at, last_seen_at, indexed_at)
		VALUES ('pic-1', 'pic.png', 1, ?, 'photo', 'present', ?, ?, ?)`, stamp, stamp, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	_ = ldb.Close()

	url := "/api/v1/libraries/" + libID + "/files/pic-1/thumbnail"
	rec := client.roundTrip(t, http.MethodGet, url+"?v=1", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("versioned thumbnail = %d (%s)", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, max-age=31536000, immutable" {
		t.Errorf("versioned Cache-Control = %q", got)
	}
	lastMod := rec.Header().Get("Last-Modified")

	rec = client.roundTrip(t, http.MethodGet, url, "")
	if got := rec.Header().Get("Cache-Control"); got != "private, no-cache" {
		t.Errorf("unversioned Cache-Control = %q", got)
	}

	req := httptest.NewRequest(http.MethodGet, url, http.NoBody)
	req.Header.Set("If-Modified-Since", lastMod)
	for name, value := range client.cookies {
		req.AddCookie(&http.Cookie{Name: name, Value: value})
	}
	rec = httptest.NewRecorder()
	client.handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotModified {
		t.Fatalf("revalidation = %d, want 304", rec.Code)
	}

	// Age the thumbnail past its file: it must be made again.
	thumb := metadata.ThumbPath(filepath.Join(libRoot, ".cairn"), "pic-1")
	old := fileMod.Add(-time.Hour)
	if err := os.Chtimes(thumb, old, old); err != nil {
		t.Fatal(err)
	}
	rec = client.roundTrip(t, http.MethodGet, url+"?v=1", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("stale thumbnail request = %d", rec.Code)
	}
	if info, err := os.Stat(thumb); err != nil || !info.ModTime().After(fileMod) {
		t.Fatalf("stale thumbnail was not regenerated (err %v)", err)
	}
}
