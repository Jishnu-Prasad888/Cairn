package httpapi

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestBrowseDirs(t *testing.T) {
	admin, libs, member := newLibraryListServer(t)
	parent := filepath.Dir(libs[0].Root)
	if err := os.WriteFile(filepath.Join(parent, "file.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(parent, ".hidden"), 0o755); err != nil {
		t.Fatal(err)
	}

	rec := admin.do(t, http.MethodGet, "/api/v1/fs/dirs?path="+url.QueryEscape(parent), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("browse = %d, body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Path   string  `json:"path"`
		Parent string  `json:"parent"`
		Dirs   []fsDir `json:"dirs"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Path != parent || resp.Parent != filepath.Dir(parent) {
		t.Errorf("path/parent = %q/%q", resp.Path, resp.Parent)
	}
	names := map[string]bool{}
	for _, d := range resp.Dirs {
		names[d.Name] = true
	}
	if !names["Alpha"] || !names["Bravo"] || names["file.txt"] || names[".hidden"] {
		t.Errorf("dirs = %v, want Alpha and Bravo only", resp.Dirs)
	}

	if rec := admin.do(t, http.MethodGet, "/api/v1/fs/dirs?path=relative", nil); rec.Code != http.StatusBadRequest {
		t.Errorf("relative path = %d, want 400", rec.Code)
	}
	if rec := admin.do(t, http.MethodGet, "/api/v1/fs/dirs?path=/definitely/not/here", nil); rec.Code != http.StatusBadRequest {
		t.Errorf("missing path = %d, want 400", rec.Code)
	}
	if rec := member().do(t, http.MethodGet, "/api/v1/fs/dirs", nil); rec.Code != http.StatusForbidden {
		t.Errorf("member = %d, want 403", rec.Code)
	}
}
