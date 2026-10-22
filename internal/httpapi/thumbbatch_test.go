package httpapi

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/crypto"
	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
)

// readBatch splits a batch response into its manifest and each item's bytes.
func readBatch(t *testing.T, body []byte) ([]thumbBatchItem, map[string][]byte) {
	t.Helper()
	if len(body) < 8 || string(body[:4]) != thumbBatchMagic {
		t.Fatalf("not a batch: %q", body)
	}
	n := binary.BigEndian.Uint32(body[4:8])
	var manifest struct {
		Items []thumbBatchItem `json:"items"`
	}
	if err := json.Unmarshal(body[8:8+n], &manifest); err != nil {
		t.Fatal(err)
	}
	data := map[string][]byte{}
	off := 8 + int(n)
	for _, it := range manifest.Items {
		if it.Missing {
			continue
		}
		data[it.ID] = body[off : off+it.Size]
		off += it.Size
	}
	if off != len(body) {
		t.Fatalf("body has %d bytes, manifest accounts for %d", len(body), off)
	}
	return manifest.Items, data
}

// TestThumbnailBatch covers the batch contract: stored thumbnails come back in
// manifest order, anything without one (not made yet, unknown) is "missing" —
// the batch never decodes an original — and a small thumbnail is derived from
// a stored full one.
func TestThumbnailBatch(t *testing.T) {
	_, client, libID, libRoot := newSearchTestServerWithKeys(t, crypto.NewKeys(""))

	for _, name := range []string{"a.png", "b.png"} {
		f, err := os.Create(filepath.Join(libRoot, name))
		if err != nil {
			t.Fatal(err)
		}
		if err := png.Encode(f, image.NewRGBA(image.Rect(0, 0, 600, 400))); err != nil {
			t.Fatal(err)
		}
		_ = f.Close()
	}
	stamp := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	ldb, err := librarydb.Open(filepath.Join(libRoot, ".cairn"))
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range [][2]string{{"a-1", "a.png"}, {"b-1", "b.png"}} {
		if _, err := ldb.Exec(`INSERT INTO indexed_files
			(id, rel_path, size_bytes, mod_time, media_type, status, first_seen_at, last_seen_at, indexed_at)
			VALUES (?, ?, 1, ?, 'photo', 'present', ?, ?, ?)`, row[0], row[1], stamp, stamp, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	_ = ldb.Close()

	batch := "/api/v1/libraries/" + libID + "/thumbnails"

	// Nothing made yet: every item is missing, and nothing was generated.
	rec := client.roundTrip(t, http.MethodGet, batch+"?ids=a-1,nope,b-1", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("batch = %d (%s)", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Errorf("Cache-Control = %q", got)
	}
	items, _ := readBatch(t, rec.Body.Bytes())
	if len(items) != 3 || items[0].ID != "a-1" || items[1].ID != "nope" || items[2].ID != "b-1" {
		t.Fatalf("manifest order = %+v", items)
	}
	for _, it := range items {
		if !it.Missing {
			t.Errorf("%s: want missing before any thumbnail exists", it.ID)
		}
	}

	// Make a's full thumbnail the usual way; the batch then derives the small one.
	if rec := client.roundTrip(t, http.MethodGet, "/api/v1/libraries/"+libID+"/files/a-1/thumbnail", ""); rec.Code != http.StatusOK {
		t.Fatalf("single thumbnail = %d", rec.Code)
	}
	rec = client.roundTrip(t, http.MethodGet, batch+"?ids=a-1,b-1&size=sm", "")
	items, data := readBatch(t, rec.Body.Bytes())
	if items[0].Missing || items[0].Size == 0 || !items[1].Missing {
		t.Fatalf("manifest = %+v", items)
	}
	img, _, err := image.DecodeConfig(bytesReader(data["a-1"]))
	if err != nil {
		t.Fatalf("a-1 is not an image: %v", err)
	}
	if img.Width != 256 {
		t.Errorf("small thumbnail width = %d, want 256", img.Width)
	}

	// size=md is the stored full thumbnail.
	rec = client.roundTrip(t, http.MethodGet, batch+"?ids=a-1&size=md", "")
	_, data = readBatch(t, rec.Body.Bytes())
	if cfg, _, err := image.DecodeConfig(bytesReader(data["a-1"])); err != nil || cfg.Width != 400 {
		t.Errorf("full thumbnail = %+v, %v; want 400 wide", cfg, err)
	}

	// ?size=sm on the single route makes what is missing.
	if rec := client.roundTrip(t, http.MethodGet, "/api/v1/libraries/"+libID+"/files/b-1/thumbnail?size=sm", ""); rec.Code != http.StatusOK {
		t.Fatalf("single small thumbnail = %d (%s)", rec.Code, rec.Body.String())
	}
	rec = client.roundTrip(t, http.MethodGet, batch+"?ids=b-1", "")
	if items, _ := readBatch(t, rec.Body.Bytes()); items[0].Missing {
		t.Error("b-1 still missing after its small thumbnail was made")
	}

	for _, bad := range []string{"", "?ids=", "?ids=a-1&size=xl"} {
		if rec := client.roundTrip(t, http.MethodGet, batch+bad, ""); rec.Code != http.StatusBadRequest {
			t.Errorf("%q = %d, want 400", bad, rec.Code)
		}
	}
}

func bytesReader(b []byte) *bytes.Reader { return bytes.NewReader(b) }
