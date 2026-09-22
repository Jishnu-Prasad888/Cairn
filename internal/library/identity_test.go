package library

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMetadataDirNaming(t *testing.T) {
	if got := metadataDir("/mnt/photos"); got != filepath.Join("/mnt/photos", ".cairn") {
		t.Errorf("metadataDir = %q, want end in /%s", got, cairnDirName)
	}
}

func TestCreateAndLoadIdentityRoundTrip(t *testing.T) {
	root := t.TempDir()
	ident, err := createIdentity(root, "My Photos", "abc123")
	if err != nil {
		t.Fatalf("createIdentity: %v", err)
	}
	if ident.ID == "" {
		t.Error("identity has no id")
	}
	if ident.Name != "My Photos" || ident.SchemaVersion != metadataSchemaVersion {
		t.Errorf("identity = %+v", ident)
	}

	loaded, err := loadIdentity(root)
	if err != nil {
		t.Fatalf("loadIdentity: %v", err)
	}
	if loaded.ID != ident.ID || loaded.Name != ident.Name || loaded.VolumeID != "abc123" {
		t.Errorf("loaded = %+v, want %+v", loaded, ident)
	}
	if !loaded.CreatedAt.Equal(ident.CreatedAt) {
		t.Errorf("created_at round trip mismatch: %v vs %v", loaded.CreatedAt, ident.CreatedAt)
	}

	if ident.ID == createIdentityMust(t, t.TempDir()).ID {
		t.Error("two identities must not collide")
	}
}

func TestLoadIdentityErrors(t *testing.T) {
	root := t.TempDir()

	if _, err := loadIdentity(root); err != errNoMetadata {
		t.Errorf("empty dir err = %v, want errNoMetadata", err)
	}

	// Malformed JSON.
	dir := metadataDir(root)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, metadataFileName), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadIdentity(root); err == nil {
		t.Error("malformed identity accepted")
	}

	// Missing id.
	if err := os.WriteFile(filepath.Join(dir, metadataFileName),
		[]byte(`{"schema_version": 1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadIdentity(root); err == nil || !strings.Contains(err.Error(), "missing a library id") {
		t.Errorf("identity without id: err = %v", err)
	}

	// Future schema version is rejected rather than assumed.
	if err := os.WriteFile(filepath.Join(dir, metadataFileName),
		[]byte(`{"id": "x", "schema_version": 99}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadIdentity(root); err == nil {
		t.Error("future schema version accepted")
	}
}

func TestHasMetadata(t *testing.T) {
	root := t.TempDir()
	if hasMetadata(root) {
		t.Error("fresh dir reports metadata")
	}
	if _, err := createIdentity(root, "x", ""); err != nil {
		t.Fatal(err)
	}
	if !hasMetadata(root) {
		t.Error("dir with identity does not report metadata")
	}
}

func TestCleanRootValidation(t *testing.T) {
	dir := t.TempDir()

	cases := []struct {
		name string
		path string
	}{
		{"empty", ""},
		{"relative", "relative/path"},
		{"missing", filepath.Join(dir, "nope")},
	}
	for _, tc := range cases {
		if _, err := cleanRoot(tc.path); err == nil {
			t.Errorf("cleanRoot(%q) expected error", tc.name)
		}
	}

	// A regular file is not a directory.
	file := filepath.Join(dir, "file.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := cleanRoot(file); err == nil {
		t.Error("file accepted as root")
	}

	// The metadata directory itself is rejected.
	if err := os.MkdirAll(metadataDir(dir), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := cleanRoot(metadataDir(dir)); err == nil {
		t.Error(".cairn directory accepted as root")
	}

	got, err := cleanRoot(dir)
	if err != nil {
		t.Fatalf("cleanRoot(tempdir): %v", err)
	}
	if got != filepath.Clean(dir) {
		t.Errorf("cleanRoot = %q, want %q", got, filepath.Clean(dir))
	}
}

func TestOverlapDetection(t *testing.T) {
	cases := []struct {
		candidate string
		roots     []string
		overlaps  bool
	}{
		{"/mnt/photos", []string{"/mnt/other"}, false},
		{"/mnt/photos", []string{"/mnt/photos"}, true},
		{"/mnt/photos/2022", []string{"/mnt/photos"}, true},            // candidate is child of existing root
		{"/mnt/photos", []string{"/mnt/photos/2022"}, true},            // candidate contains an existing root
		{"/mnt/photos/to/join", []string{"/mnt/photos/folder"}, false}, // sibling subtrees, no overlap
		{"/mnt/photos2", []string{"/mnt/photos"}, false},               // sibling, common prefix not a boundary
	}
	for _, tc := range cases {
		if conflict, ok := overlappingRoot(tc.candidate, tc.roots); ok != tc.overlaps {
			t.Errorf("overlap(%q, %v) = (%q, %v), want overlaps=%v",
				tc.candidate, tc.roots, conflict, ok, tc.overlaps)
		}
	}
}

func createIdentityMust(t *testing.T, root string) *identity {
	t.Helper()
	ident, err := createIdentity(root, "x", "")
	if err != nil {
		t.Fatalf("createIdentity: %v", err)
	}
	return ident
}

func TestVolumeID(t *testing.T) {
	dir := t.TempDir()
	if _, ok := volumeID(dir); !ok {
		t.Skip("platform does not expose a volume identity")
	}
	a, ok := volumeID(dir)
	if !ok {
		t.Skip("platform does not expose a volume identity")
	}
	b, _ := volumeID(dir)
	if a != b {
		t.Errorf("volume id not stable: %q vs %q", a, b)
	}
}
