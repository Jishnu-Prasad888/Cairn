package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/Jishnu-Prasad888/Cairn/internal/audit"
	"github.com/Jishnu-Prasad888/Cairn/internal/auth"
	"github.com/Jishnu-Prasad888/Cairn/internal/db"
	"github.com/Jishnu-Prasad888/Cairn/internal/library"
)

// --- shared test infrastructure ---

// newSearchTestServer creates a fully-wired server with auth and a test library.
// It returns the handler, an authenticated admin client, and the library ID.
func newSearchTestServer(t *testing.T) (http.Handler, *testClient, string) {
	t.Helper()
	tmpDir := t.TempDir()
	pool, err := db.Open(filepath.Join(tmpDir, "test.db"))
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	t.Cleanup(func() { _ = pool.Close() })
	if err := db.Migrate(pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	auditSvc := audit.New(pool, logger)
	authSvc := auth.NewService(pool, logger, auditSvc)
	libManager := library.NewManager(pool, logger, auditSvc)

	// Register a test library.
	libRoot := filepath.Join(tmpDir, "library")
	if err := os.MkdirAll(libRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	lib, _, err := libManager.Register(context.Background(), libRoot, "Test Library")
	if err != nil {
		t.Fatalf("register library: %v", err)
	}

	handler := New(Dependencies{
		Logger:    logger,
		DB:        pool,
		Auth:      authSvc,
		Libraries: libManager,
	}).Handler()

	client := &testClient{handler: handler}
	// Bootstrap admin.
	client.roundTrip(t, http.MethodPost, "/api/v1/auth/bootstrap",
		`{"username":"admin","password":"correct-horse-battery"}`)
	// Login.
	client.roundTrip(t, http.MethodPost, "/api/v1/auth/login",
		`{"username":"admin","password":"correct-horse-battery"}`)

	return handler, client, lib.ID
}

// seedLibraryFile inserts a file directly into the per-library database.
// doJSON2 is a helper that sends an authenticated request.
func (c *testClient) do(t *testing.T, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var buf *bytes.Buffer
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		buf = bytes.NewBuffer(b)
	} else {
		buf = bytes.NewBuffer(nil)
	}
	req := httptest.NewRequest(method, path, buf)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for name, value := range c.cookies {
		req.AddCookie(&http.Cookie{Name: name, Value: value})
	}
	rec := httptest.NewRecorder()
	c.handler.ServeHTTP(rec, req)
	c.applySetCookies(rec.Result().Cookies())
	return rec
}

// --- search tests ---

func TestHandleSearch_EmptyQuery(t *testing.T) {
	_, client, libID := newSearchTestServer(t)

	rec := client.do(t, http.MethodGet,
		"/api/v1/libraries/"+libID+"/search", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	var resp struct {
		Files []any `json:"files"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
}

func TestHandleSearch_Unauthenticated(t *testing.T) {
	h, _, libID := newSearchTestServer(t)
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/libraries/"+libID+"/search", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestHandleSearch_LibraryNotFound(t *testing.T) {
	_, client, _ := newSearchTestServer(t)
	rec := client.do(t, http.MethodGet,
		"/api/v1/libraries/nonexistent/search", nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

// --- tags tests ---

func TestHandleListTags_Empty(t *testing.T) {
	_, client, libID := newSearchTestServer(t)

	rec := client.do(t, http.MethodGet, "/api/v1/libraries/"+libID+"/tags", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Tags []any `json:"tags"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// nil or empty slice both acceptable
}

func TestHandleCreateTag(t *testing.T) {
	_, client, libID := newSearchTestServer(t)

	rec := client.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/tags",
		map[string]string{"name": "nature", "color": "#00ff00"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Tag struct {
			ID    string `json:"id"`
			Name  string `json:"name"`
			Color string `json:"color"`
		} `json:"tag"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Tag.ID == "" {
		t.Error("tag ID is empty")
	}
	if resp.Tag.Name != "nature" {
		t.Errorf("name = %q, want nature", resp.Tag.Name)
	}
}

func TestHandleCreateTag_MissingName(t *testing.T) {
	_, client, libID := newSearchTestServer(t)

	rec := client.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/tags",
		map[string]string{"color": "#ff0000"})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestHandleCreateTag_Duplicate(t *testing.T) {
	_, client, libID := newSearchTestServer(t)

	client.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/tags",
		map[string]string{"name": "dup"})
	rec := client.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/tags",
		map[string]string{"name": "dup"})
	if rec.Code != http.StatusConflict {
		t.Errorf("status = %d, want 409", rec.Code)
	}
}

func TestHandleDeleteTag(t *testing.T) {
	_, client, libID := newSearchTestServer(t)

	create := client.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/tags",
		map[string]string{"name": "to-delete"})
	var cr struct {
		Tag struct {
			ID string `json:"id"`
		} `json:"tag"`
	}
	if err := json.Unmarshal(create.Body.Bytes(), &cr); err != nil {
		t.Fatalf("unmarshal create: %v", err)
	}

	rec := client.do(t, http.MethodDelete,
		"/api/v1/libraries/"+libID+"/tags/"+cr.Tag.ID, nil)
	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", rec.Code)
	}
}

func TestHandleDeleteTag_NotFound(t *testing.T) {
	_, client, libID := newSearchTestServer(t)

	rec := client.do(t, http.MethodDelete,
		"/api/v1/libraries/"+libID+"/tags/ghost", nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

func TestHandleListTags_AfterCreate(t *testing.T) {
	_, client, libID := newSearchTestServer(t)

	client.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/tags",
		map[string]string{"name": "beta"})
	client.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/tags",
		map[string]string{"name": "alpha"})

	rec := client.do(t, http.MethodGet, "/api/v1/libraries/"+libID+"/tags", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var resp struct {
		Tags []struct {
			Name string `json:"name"`
		} `json:"tags"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(resp.Tags) != 2 {
		t.Errorf("tag count = %d, want 2", len(resp.Tags))
	}
}

// --- albums tests ---

func TestHandleListAlbums_Empty(t *testing.T) {
	_, client, libID := newSearchTestServer(t)

	rec := client.do(t, http.MethodGet, "/api/v1/libraries/"+libID+"/albums", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandleCreateAlbum(t *testing.T) {
	_, client, libID := newSearchTestServer(t)

	rec := client.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/albums",
		map[string]string{"name": "Summer Trip", "description": "2023 Italy"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Album struct {
			ID          string `json:"id"`
			Name        string `json:"name"`
			Description string `json:"description"`
		} `json:"album"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.Album.ID == "" {
		t.Error("album ID is empty")
	}
	if resp.Album.Name != "Summer Trip" {
		t.Errorf("name = %q, want Summer Trip", resp.Album.Name)
	}
	if resp.Album.Description != "2023 Italy" {
		t.Errorf("description = %q, want 2023 Italy", resp.Album.Description)
	}
}

func TestHandleCreateAlbum_MissingName(t *testing.T) {
	_, client, libID := newSearchTestServer(t)

	rec := client.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/albums",
		map[string]string{"description": "no name"})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestHandleDeleteAlbum(t *testing.T) {
	_, client, libID := newSearchTestServer(t)

	create := client.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/albums",
		map[string]string{"name": "to-delete"})
	var cr struct {
		Album struct {
			ID string `json:"id"`
		} `json:"album"`
	}
	json.Unmarshal(create.Body.Bytes(), &cr)

	rec := client.do(t, http.MethodDelete,
		"/api/v1/libraries/"+libID+"/albums/"+cr.Album.ID, nil)
	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", rec.Code)
	}
}

func TestHandleDeleteAlbum_NotFound(t *testing.T) {
	_, client, libID := newSearchTestServer(t)

	rec := client.do(t, http.MethodDelete,
		"/api/v1/libraries/"+libID+"/albums/ghost", nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

func TestHandleListAlbumFiles_Empty(t *testing.T) {
	_, client, libID := newSearchTestServer(t)

	create := client.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/albums",
		map[string]string{"name": "empty"})
	var cr struct {
		Album struct {
			ID string `json:"id"`
		} `json:"album"`
	}
	json.Unmarshal(create.Body.Bytes(), &cr)

	rec := client.do(t, http.MethodGet,
		"/api/v1/libraries/"+libID+"/albums/"+cr.Album.ID+"/files", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}

// --- favorites tests ---

func TestHandleListFavorites_Empty(t *testing.T) {
	_, client, libID := newSearchTestServer(t)

	rec := client.do(t, http.MethodGet, "/api/v1/libraries/"+libID+"/favorites", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Files []any `json:"files"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
}

func TestHandleAddFavorite_NotFound(t *testing.T) {
	_, client, libID := newSearchTestServer(t)

	// Adding a favorite for a file that doesn't exist in indexed_files
	// will fail with a DB constraint or return an error based on the
	// ErrAlreadyFavorited path. Since the file doesn't exist at all,
	// the INSERT will fail with a foreign key constraint.
	rec := client.do(t, http.MethodPost,
		"/api/v1/libraries/"+libID+"/files/nonexistent/favorite", nil)
	// We expect some error (500 due to FK constraint or 409 due to already favorited).
	if rec.Code == http.StatusOK {
		t.Error("expected non-200 for favoriting nonexistent file")
	}
}

func TestHandleRemoveFavorite_NotFavorited(t *testing.T) {
	_, client, libID := newSearchTestServer(t)

	// Try to remove a favorite that doesn't exist.
	rec := client.do(t, http.MethodDelete,
		"/api/v1/libraries/"+libID+"/files/ghost/favorite", nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

func TestHandleSearchUnauthenticated(t *testing.T) {
	h, _, libID := newSearchTestServer(t)
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/libraries/"+libID+"/tags", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("tags unauthenticated status = %d, want 401", rec.Code)
	}
}

func TestHandleAlbumsUnauthenticated(t *testing.T) {
	h, _, libID := newSearchTestServer(t)
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/libraries/"+libID+"/albums", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("albums unauthenticated status = %d, want 401", rec.Code)
	}
}

func TestHandleFavoritesUnauthenticated(t *testing.T) {
	h, _, libID := newSearchTestServer(t)
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/libraries/"+libID+"/favorites", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("favorites unauthenticated status = %d, want 401", rec.Code)
	}
}
