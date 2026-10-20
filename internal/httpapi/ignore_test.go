package httpapi

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/Jishnu-Prasad888/Cairn/internal/indexer"
)

func TestIgnoreRulesRoundTrip(t *testing.T) {
	admin, libs, member := newLibraryListServer(t)
	lib := libs[0]
	base := "/api/v1/libraries/" + lib.ID + "/ignore"

	rec := admin.do(t, http.MethodGet, base, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get = %d, body=%s", rec.Code, rec.Body.String())
	}

	rec = admin.do(t, http.MethodPut, base, map[string]any{"rules": []indexer.IgnoreRule{
		{Kind: "path", Pattern: filepath.Join(lib.Root, "raw")},
		{Kind: "extension", Pattern: ".XMP"},
	}})
	if rec.Code != http.StatusOK {
		t.Fatalf("put = %d, body=%s", rec.Code, rec.Body.String())
	}

	rec = admin.do(t, http.MethodGet, base, nil)
	var resp struct {
		Rules []indexer.IgnoreRule `json:"rules"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Rules) != 2 || resp.Rules[0].Pattern != "raw" || resp.Rules[1].Pattern != "xmp" {
		t.Errorf("rules = %v", resp.Rules)
	}

	rec = admin.do(t, http.MethodPut, base, map[string]any{"rules": []indexer.IgnoreRule{
		{Kind: "path", Pattern: "/etc"},
	}})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("path outside library = %d, want 400", rec.Code)
	}
	if rec := member().do(t, http.MethodGet, base, nil); rec.Code != http.StatusForbidden {
		t.Errorf("member = %d, want 403", rec.Code)
	}
}

func TestBrowseLibrary(t *testing.T) {
	admin, libs, _ := newLibraryListServer(t)
	lib := libs[0]
	for _, rel := range []string{"2019/a.jpg", "2019/raw/b.cr2", "top.jpg"} {
		p := filepath.Join(lib.Root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	base := "/api/v1/libraries/" + lib.ID + "/fs"

	type listing struct {
		Path   string         `json:"path"`
		Parent string         `json:"parent"`
		Dirs   []libraryEntry `json:"dirs"`
		Files  []libraryEntry `json:"files"`
	}
	get := func(rel string) listing {
		t.Helper()
		rec := admin.do(t, http.MethodGet, base+"?path="+url.QueryEscape(rel), nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("browse %q = %d, body=%s", rel, rec.Code, rec.Body.String())
		}
		var l listing
		if err := json.Unmarshal(rec.Body.Bytes(), &l); err != nil {
			t.Fatal(err)
		}
		return l
	}

	top := get("")
	for _, d := range top.Dirs {
		if d.Name == ".cairn" {
			t.Error("root listing shows .cairn")
		}
	}
	if len(top.Files) != 1 || top.Files[0].Path != "top.jpg" {
		t.Errorf("root files = %v", top.Files)
	}

	sub := get("2019")
	if sub.Parent != "" || len(sub.Dirs) != 1 || sub.Dirs[0].Path != "2019/raw" ||
		len(sub.Files) != 1 || sub.Files[0].Path != "2019/a.jpg" {
		t.Errorf("2019 listing = %+v", sub)
	}

	for _, bad := range []string{"../", ".cairn", "/etc"} {
		if rec := admin.do(t, http.MethodGet, base+"?path="+url.QueryEscape(bad), nil); rec.Code != http.StatusBadRequest {
			t.Errorf("browse %q = %d, want 400", bad, rec.Code)
		}
	}
}
