package httpapi

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// seedDiskFile writes a real file under the library root and indexes it.
func seedDiskFile(t *testing.T, libRoot, id, relPath, content string) {
	t.Helper()
	abs := filepath.Join(libRoot, filepath.FromSlash(relPath))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	seedLibraryFileHash(t, libRoot, id, relPath, int64(len(content)), "h-"+id)
}

func folderNames(t *testing.T, rec interface{ Bytes() []byte }) []string {
	t.Helper()
	var body struct {
		Folders []struct {
			Name      string `json:"name"`
			RelPath   string `json:"rel_path"`
			FileCount int    `json:"file_count"`
			SizeBytes int64  `json:"size_bytes"`
			ModTime   string `json:"mod_time"`
		} `json:"folders"`
	}
	if err := json.Unmarshal(rec.Bytes(), &body); err != nil {
		t.Fatalf("decode folders: %v", err)
	}
	out := make([]string, 0, len(body.Folders))
	for _, f := range body.Folders {
		out = append(out, f.RelPath)
	}
	return out
}

func TestFolderListingCarriesSizeAndDate(t *testing.T) {
	_, client, libID, libRoot := newSearchTestServer(t)
	seedDiskFile(t, libRoot, "a", "Trips/a.jpg", "12345")
	seedDiskFile(t, libRoot, "b", "Trips/2024/b.jpg", "123")

	rec := client.do(t, http.MethodGet, "/api/v1/libraries/"+libID+"/folders", nil)
	var body struct {
		Folders []struct {
			FileCount int    `json:"file_count"`
			SizeBytes int64  `json:"size_bytes"`
			ModTime   string `json:"mod_time"`
		} `json:"folders"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || len(body.Folders) != 1 {
		t.Fatalf("folders = %s (err %v)", rec.Body.String(), err)
	}
	f := body.Folders[0]
	if f.FileCount != 2 || f.SizeBytes != 8 || f.ModTime == "" {
		t.Fatalf("folder = %+v, want 2 files, 8 bytes and a date", f)
	}
}

func TestMoveFolderRewritesIndexAndFavorites(t *testing.T) {
	_, client, libID, libRoot := newSearchTestServer(t)
	seedDiskFile(t, libRoot, "a", "Trips/a.jpg", "a")
	seedDiskFile(t, libRoot, "b", "Trips/2024/b.jpg", "b")
	seedDiskFile(t, libRoot, "c", "Trips2/c.jpg", "c") // shares a prefix, must not move
	base := "/api/v1/libraries/" + libID

	if rec := client.do(t, http.MethodPut, base+"/folders/favorite?path=Trips/2024", nil); rec.Code != http.StatusNoContent {
		t.Fatalf("favorite status = %d (%s)", rec.Code, rec.Body.String())
	}
	rec := client.do(t, http.MethodPost, base+"/folders/move",
		map[string]string{"path": "Trips", "new_path": "Archive/Holidays"})
	if rec.Code != http.StatusOK {
		t.Fatalf("move status = %d (%s)", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(libRoot, "Archive", "Holidays", "2024", "b.jpg")); err != nil {
		t.Fatalf("moved file not on disk: %v", err)
	}
	rec = client.do(t, http.MethodGet, base+"/files/b", nil)
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"rel_path":"Archive/Holidays/2024/b.jpg"`)) {
		t.Fatalf("index not rewritten: %s", rec.Body.String())
	}
	rec = client.do(t, http.MethodGet, base+"/files/c", nil)
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"rel_path":"Trips2/c.jpg"`)) {
		t.Fatalf("sibling with a shared prefix moved: %s", rec.Body.String())
	}
	rec = client.do(t, http.MethodGet, base+"/favorites/folders", nil)
	if got := folderNames(t, rec.Body); len(got) != 1 || got[0] != "Archive/Holidays/2024" {
		t.Fatalf("favourite folders = %v, want the moved path", got)
	}

	// Into itself, and onto something that exists, are refused.
	rec = client.do(t, http.MethodPost, base+"/folders/move",
		map[string]string{"path": "Archive", "new_path": "Archive/Holidays/inner"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("move into itself = %d, want 400", rec.Code)
	}
	rec = client.do(t, http.MethodPost, base+"/folders/move",
		map[string]string{"path": "Archive", "new_path": "Trips2"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("move onto existing = %d, want 409", rec.Code)
	}
}

func TestTrashFolderTrashesEveryFileAndRemovesDirs(t *testing.T) {
	_, client, libID, libRoot := newSearchTestServer(t)
	seedDiskFile(t, libRoot, "a", "Old/a.jpg", "a")
	seedDiskFile(t, libRoot, "b", "Old/deep/b.jpg", "b")
	base := "/api/v1/libraries/" + libID

	rec := client.do(t, http.MethodPost, base+"/folders/trash", map[string]string{"path": "Old"})
	if rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte(`"trashed":2`)) {
		t.Fatalf("trash = %d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(libRoot, "Old")); !os.IsNotExist(err) {
		t.Fatalf("emptied folder still on disk: %v", err)
	}
	rec = client.do(t, http.MethodGet, base+"/trash", nil)
	if !bytes.Contains(rec.Body.Bytes(), []byte("a.jpg")) || !bytes.Contains(rec.Body.Bytes(), []byte("b.jpg")) {
		t.Fatalf("trash listing = %s", rec.Body.String())
	}
}

func TestDownloadFolderZip(t *testing.T) {
	_, client, libID, libRoot := newSearchTestServer(t)
	seedDiskFile(t, libRoot, "a", "Pics/a.jpg", "alpha")
	seedDiskFile(t, libRoot, "b", "Pics/sub/b.jpg", "beta")

	rec := client.do(t, http.MethodGet, "/api/v1/libraries/"+libID+"/folders/download?path=Pics", nil)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("download = %d %s", rec.Code, rec.Header().Get("Content-Type"))
	}
	data := rec.Body.Bytes()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
		if f.Name == "sub/b.jpg" {
			rc, _ := f.Open()
			got, _ := io.ReadAll(rc)
			_ = rc.Close()
			if string(got) != "beta" {
				t.Fatalf("sub/b.jpg = %q", got)
			}
		}
	}
	sort.Strings(names)
	if len(names) != 2 || names[0] != "a.jpg" || names[1] != "sub/b.jpg" {
		t.Fatalf("zip entries = %v", names)
	}
}
