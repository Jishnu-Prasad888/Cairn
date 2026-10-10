package httpapi

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/Jishnu-Prasad888/Cairn/internal/authz"
)

// zipEntries indexes a zip archive's decompressed entries by name.
func zipEntries(t *testing.T, data []byte) map[string][]byte {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("open export zip: %v", err)
	}
	out := map[string][]byte{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open %s: %v", f.Name, err)
		}
		b, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatalf("read %s: %v", f.Name, err)
		}
		out[f.Name] = b
	}
	return out
}

func zipNames(entries map[string][]byte) []string {
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func TestExportMemory(t *testing.T) {
	_, client, libID, libRoot := newSearchTestServer(t)
	orig := seedPhoto(t, libRoot, "p1", "kerala/1.jpg")
	origBytes, err := os.ReadFile(orig)
	if err != nil {
		t.Fatal(err)
	}
	m := createMemory(t, client, libID)
	base := "/api/v1/libraries/" + libID + "/memories/" + m.Memory.ID

	rec := client.do(t, http.MethodPost, base+"/blocks",
		map[string]any{"type": "image", "file_ids": []string{"p1"}})
	if rec.Code != http.StatusOK {
		t.Fatalf("add image block = %d %s", rec.Code, rec.Body.String())
	}
	imageID := decodeDoc(t, rec.Body.Bytes()).Memory.Blocks[1].Images[0].ID
	rec = client.do(t, http.MethodPatch, base+"/images/"+imageID,
		map[string]any{"caption": "Backwater", "rotation": 90})
	if rec.Code != http.StatusOK {
		t.Fatalf("edit image = %d %s", rec.Code, rec.Body.String())
	}

	rec = client.do(t, http.MethodGet, base+"/export", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("export = %d %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/zip" {
		t.Errorf("content-type = %q, want application/zip", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.Contains(cd, "my-trip-to-kerala.zip") {
		t.Errorf("content-disposition = %q", cd)
	}

	entries := zipEntries(t, rec.Body.Bytes())
	md, ok := entries["my-trip-to-kerala.md"]
	if !ok {
		t.Fatalf("entries = %v", zipNames(entries))
	}
	body := string(md)
	for _, want := range []string{
		`title: "My Trip to Kerala"`,
		`cairn_memory_id: "` + m.Memory.ID + `"`,
		"We left early.",
		`![Backwater](images/`,
		`edit="rotation=90"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("markdown missing %q:\n%s", want, body)
		}
	}

	var imageName string
	for name := range entries {
		if strings.HasPrefix(name, "images/") {
			imageName = name
		}
	}
	if imageName == "" {
		t.Fatalf("no image entry: %v", zipNames(entries))
	}
	if !bytes.Equal(entries[imageName], origBytes) {
		t.Errorf("embedded image bytes differ from the original")
	}
}

func TestExportMemoryForbiddenImageOmitted(t *testing.T) {
	_, admin, viewer, libID := newAuthzTestServer(t)
	rec := admin.do(t, http.MethodGet, "/api/v1/libraries/"+libID, nil)
	var libResp struct {
		Library struct {
			Root string `json:"root"`
		} `json:"library"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &libResp); err != nil {
		t.Fatal(err)
	}
	root := libResp.Library.Root
	seedPhoto(t, root, "open1", "shared/open.jpg")
	seedPhoto(t, root, "secret1", "private/secret.jpg")

	vid := viewerID(t, admin)
	grantCap(t, admin, libID, vid, authz.LibraryKey(libID), []string{"read", "create", "edit"})
	denyCap(t, admin, libID, vid, authz.FolderKey(libID, "private"), []string{"read"})

	m := createMemory(t, viewer, libID)
	base := "/api/v1/libraries/" + libID + "/memories/" + m.Memory.ID
	rec = viewer.do(t, http.MethodPost, base+"/blocks",
		map[string]any{"type": "image", "file_ids": []string{"open1"}})
	if rec.Code != http.StatusOK {
		t.Fatalf("viewer add permitted photo = %d %s", rec.Code, rec.Body.String())
	}
	d := decodeDoc(t, viewer.do(t, http.MethodGet, base, nil).Body.Bytes())
	blockID := d.Memory.Blocks[1].ID
	if rec := admin.do(t, http.MethodPost, base+"/blocks/"+blockID+"/images",
		map[string]any{"file_ids": []string{"secret1"}}); rec.Code != http.StatusOK {
		t.Fatalf("admin add secret = %d %s", rec.Code, rec.Body.String())
	}

	rec = viewer.do(t, http.MethodGet, base+"/export", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("viewer export = %d %s", rec.Code, rec.Body.String())
	}
	entries := zipEntries(t, rec.Body.Bytes())
	body := string(entries["my-trip-to-kerala.md"])
	if strings.Contains(body, "secret.jpg") {
		t.Errorf("export leaked a forbidden path:\n%s", body)
	}
	if !strings.Contains(body, `unavailable="forbidden"`) {
		t.Errorf("forbidden image not marked:\n%s", body)
	}
	embedded := 0
	for name := range entries {
		if strings.HasPrefix(name, "images/") {
			embedded++
		}
	}
	if embedded != 1 {
		t.Errorf("embedded %d images, want only the readable one (%v)", embedded, zipNames(entries))
	}
}

func TestExportMemoryNotFound(t *testing.T) {
	_, client, libID, _ := newSearchTestServer(t)
	rec := client.do(t, http.MethodGet, "/api/v1/libraries/"+libID+"/memories/ghost/export", nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("export ghost = %d, want 404", rec.Code)
	}
}

func TestExportMemoryUnauthenticated(t *testing.T) {
	h, _, libID, _ := newSearchTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/libraries/"+libID+"/memories/ghost/export", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated export = %d, want 401", rec.Code)
	}
}
