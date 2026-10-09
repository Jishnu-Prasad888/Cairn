package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/jpeg"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/Jishnu-Prasad888/Cairn/internal/audit"
	"github.com/Jishnu-Prasad888/Cairn/internal/auth"
	"github.com/Jishnu-Prasad888/Cairn/internal/authz"
	"github.com/Jishnu-Prasad888/Cairn/internal/crypto"
	"github.com/Jishnu-Prasad888/Cairn/internal/db"
	"github.com/Jishnu-Prasad888/Cairn/internal/library"
)

// newAuthzTestServer wires the full dependency graph including the
// authorization service and a registered library. It returns the admin client
// and a logged-in non-admin viewer client (no grants created yet).
func newAuthzTestServer(t *testing.T) (http.Handler, *testClient, *testClient, string) {
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
	authzSvc := authz.NewService(pool, logger, nil)
	libManager := library.NewManager(pool, logger, auditSvc, crypto.NewKeys(""))

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
		Authz:     authzSvc,
		Libraries: libManager,
	}).Handler()

	admin := &testClient{handler: handler}
	admin.roundTrip(t, http.MethodPost, "/api/v1/auth/bootstrap",
		`{"username":"admin","password":"correct-horse-battery"}`)

	// Viewer account (non-admin) and its own session.
	create := admin.do(t, http.MethodPost, "/api/v1/users",
		map[string]string{"username": "viewer", "password": "viewer-password"})
	var cu struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	if err := json.Unmarshal(create.Body.Bytes(), &cu); err != nil {
		t.Fatalf("unmarshal created user: %v (body=%s)", err, create.Body.Bytes())
	}

	viewer := &testClient{handler: handler}
	viewer.roundTrip(t, http.MethodPost, "/api/v1/auth/login",
		`{"username":"viewer","password":"viewer-password"}`)

	return handler, admin, viewer, lib.ID
}

// rawUpload performs a multipart upload against the live endpoint and returns
// the recorder so callers can assert either success or a denial.
func rawUpload(t *testing.T, c *testClient, libID, path string) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", filepath.Base(path))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write([]byte("hello cairn")); err != nil {
		t.Fatal(err)
	}
	if err := mw.WriteField("path", path); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost,
		"/api/v1/libraries/"+libID+"/files/upload", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	for name, value := range c.cookies {
		req.AddCookie(&http.Cookie{Name: name, Value: value})
	}
	rec := httptest.NewRecorder()
	c.handler.ServeHTTP(rec, req)
	c.applySetCookies(rec.Result().Cookies())
	return rec
}

// uploadFile uploads a small file through the live upload endpoint.
func uploadFile(t *testing.T, c *testClient, libID, path string) string {
	t.Helper()
	rec := rawUpload(t, c, libID, path)
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		File struct {
			ID string `json:"id"`
		} `json:"file"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal upload: %v", err)
	}
	return resp.File.ID
}

// uploadJPEG uploads a real, decodable JPEG through the live upload endpoint —
// unlike uploadFile's placeholder bytes, this is needed wherever the test
// exercises thumbnail generation, which has to decode the source image.
func uploadJPEG(t *testing.T, c *testClient, libID, path string) string {
	t.Helper()
	var jpegBuf bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 64, 48))
	if err := jpeg.Encode(&jpegBuf, img, nil); err != nil {
		t.Fatalf("encode test jpeg: %v", err)
	}

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", filepath.Base(path))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(jpegBuf.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := mw.WriteField("path", path); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/libraries/"+libID+"/files/upload", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	for name, value := range c.cookies {
		req.AddCookie(&http.Cookie{Name: name, Value: value})
	}
	rec := httptest.NewRecorder()
	c.handler.ServeHTTP(rec, req)
	c.applySetCookies(rec.Result().Cookies())
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload jpeg status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		File struct {
			ID string `json:"id"`
		} `json:"file"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal upload: %v", err)
	}
	return resp.File.ID
}

func grantCap(t *testing.T, c *testClient, libID, userID, key string, caps []string) {
	t.Helper()
	rec := c.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/permissions",
		map[string]any{
			"user_id": userID,
			"key":     key,
			"caps":    caps,
			"effect":  "allow",
		})
	if rec.Code != http.StatusCreated {
		t.Fatalf("grant status = %d, body=%s", rec.Code, rec.Body.String())
	}
}

func denyCap(t *testing.T, c *testClient, libID, userID, key string, caps []string) {
	t.Helper()
	rec := c.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/permissions",
		map[string]any{
			"user_id": userID,
			"key":     key,
			"caps":    caps,
			"effect":  "deny",
		})
	if rec.Code != http.StatusCreated {
		t.Fatalf("deny status = %d, body=%s", rec.Code, rec.Body.String())
	}
}

const viewerUser = "viewer"

func viewerID(t *testing.T, admin *testClient) string {
	t.Helper()
	rec := admin.do(t, http.MethodGet, "/api/v1/users", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list users status = %d", rec.Code)
	}
	var resp struct {
		Users []struct {
			ID       string `json:"id"`
			Username string `json:"username"`
		} `json:"users"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal users: %v", err)
	}
	for _, u := range resp.Users {
		if u.Username == viewerUser {
			return u.ID
		}
	}
	t.Fatal("viewer user not found")
	return ""
}

func TestAuthz_ReadGrantGrantsAccess(t *testing.T) {
	_, admin, viewer, libID := newAuthzTestServer(t)
	fileID := uploadFile(t, admin, libID, "photos/sunset.jpg")

	vid := viewerID(t, admin)
	grantCap(t, admin, libID, vid, authz.LibraryKey(libID), []string{"read"})

	// Viewer can list the library and fetch file metadata (read).
	rec := viewer.do(t, http.MethodGet,
		"/api/v1/libraries/"+libID+"/files?folder=photos", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("viewer list = %d, body=%s", rec.Code, rec.Body.String())
	}
	rec = viewer.do(t, http.MethodGet,
		"/api/v1/libraries/"+libID+"/files/"+fileID, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("viewer get = %d, body=%s", rec.Code, rec.Body.String())
	}
	// Read is not download.
	rec = viewer.do(t, http.MethodGet,
		"/api/v1/libraries/"+libID+"/files/"+fileID+"/download", nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("viewer download = %d, want 403", rec.Code)
	}
	// Read is not create.
	rec = rawUpload(t, viewer, libID, "photos/intruder.jpg")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("viewer upload = %d, want 403", rec.Code)
	}
	// Read is not manage: permissions and shares stay admin-only.
	rec = viewer.do(t, http.MethodGet,
		"/api/v1/libraries/"+libID+"/permissions", nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("viewer list grants = %d, want 403", rec.Code)
	}
	rec = viewer.do(t, http.MethodPost,
		"/api/v1/libraries/"+libID+"/shares",
		map[string]any{"key": authz.LibraryKey(libID), "caps": []string{"read"}})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("viewer create share = %d, want 403", rec.Code)
	}
}

func TestAuthz_DenyOverridesInheritedAllow(t *testing.T) {
	_, admin, viewer, libID := newAuthzTestServer(t)
	uploadFile(t, admin, libID, "photos/sunset.jpg")
	uploadFile(t, admin, libID, "private/secret.jpg")

	vid := viewerID(t, admin)
	grantCap(t, admin, libID, vid, authz.LibraryKey(libID), []string{"read"})
	denyCap(t, admin, libID, vid, authz.FolderKey(libID, "private"), []string{"read"})

	// The library allow still applies everywhere except the denied subtree.
	rec := viewer.do(t, http.MethodGet,
		"/api/v1/libraries/"+libID+"/files?folder=photos", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("viewer list photos = %d, want 200", rec.Code)
	}
	rec = viewer.do(t, http.MethodGet,
		"/api/v1/libraries/"+libID+"/files?folder=private", nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("viewer list private = %d, want 403", rec.Code)
	}
}

func TestAuthz_PermissionsRequireManage(t *testing.T) {
	_, admin, viewer, libID := newAuthzTestServer(t)
	vid := viewerID(t, admin)
	grantCap(t, admin, libID, vid, authz.LibraryKey(libID),
		[]string{"read", "manage"})

	// Manage now lets the viewer administer permissions (including self-grants).
	rec := viewer.do(t, http.MethodGet,
		"/api/v1/libraries/"+libID+"/permissions", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("viewer list grants = %d, want 200", rec.Code)
	}
}

func TestAuthz_PublicShareFlow(t *testing.T) {
	_, admin, _, libID := newAuthzTestServer(t)
	fileID := uploadFile(t, admin, libID, "photos/sunset.jpg")

	rec := admin.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/shares",
		map[string]any{
			"key":      authz.FolderKey(libID, "photos"),
			"caps":     []string{"read", "download"},
			"password": "sekrit-pass",
		})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create share = %d, body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal share: %v", err)
	}
	if resp.Token == "" {
		t.Fatal("share token is empty")
	}

	// Public requests carry no session; the password is required.
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/shares/"+resp.Token+"/files?folder=photos", nil)
	rr := httptest.NewRecorder()
	admin.handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("share without password = %d, want 401", rr.Code)
	}

	// With the password the share lists its subtree.
	req = httptest.NewRequest(http.MethodGet,
		"/api/v1/shares/"+resp.Token+"/files?folder=photos", nil)
	req.Header.Set(sharePasswordHeader, "sekrit-pass")
	rr = httptest.NewRecorder()
	admin.handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("share list = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}

	// Download executes with read+download.
	req = httptest.NewRequest(http.MethodGet,
		"/api/v1/shares/"+resp.Token+"/files/"+fileID+"/download", nil)
	req.Header.Set(sharePasswordHeader, "sekrit-pass")
	rr = httptest.NewRecorder()
	admin.handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("share download = %d, want 200", rr.Code)
	}
}

func TestAuthz_PublicShareReadOnlyHasNoDownload(t *testing.T) {
	_, admin, _, libID := newAuthzTestServer(t)
	fileID := uploadFile(t, admin, libID, "photos/sunset.jpg")

	rec := admin.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/shares",
		map[string]any{
			"key":  authz.FolderKey(libID, "photos"),
			"caps": []string{"read"},
		})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create share = %d, body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal share: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/shares/"+resp.Token+"/files/"+fileID+"/download", nil)
	rr := httptest.NewRecorder()
	admin.handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("read-only share download = %d, want 403", rr.Code)
	}
}

func TestAuthz_RevokedShareIsImmediatelyDead(t *testing.T) {
	_, admin, _, libID := newAuthzTestServer(t)
	uploadFile(t, admin, libID, "photos/sunset.jpg")

	rec := admin.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/shares",
		map[string]any{
			"key":  authz.FolderKey(libID, "photos"),
			"caps": []string{"read"},
		})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create share = %d, body=%s", rec.Code, rec.Body.String())
	}
	var created struct {
		Share struct {
			ID string `json:"id"`
		} `json:"share"`
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("unmarshal share: %v", err)
	}

	rec = admin.do(t, http.MethodDelete,
		"/api/v1/libraries/"+libID+"/shares/"+created.Share.ID, nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("revoke share = %d, want 204", rec.Code)
	}

	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/shares/"+created.Token, nil)
	rr := httptest.NewRecorder()
	admin.handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("revoked share = %d, want 401", rr.Code)
	}
}

// An album's files are not reachable through the folder/file key hierarchy a
// folder or library share walks — they can live anywhere, so a share rooted
// at an album entity key needs its own resolution path (albumIDFromShareKey /
// publicShareAllowsFile in shares_public.go). This exercises that path
// end to end: list, get, and download through a public album share, and
// confirms a file that merely lives alongside the album is not leaked.
func TestAuthz_PublicAlbumShare(t *testing.T) {
	_, admin, _, libID := newAuthzTestServer(t)
	inAlbum := uploadFile(t, admin, libID, "photos/sunset.jpg")
	outsideAlbum := uploadFile(t, admin, libID, "photos/other.jpg")

	create := admin.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/albums",
		map[string]string{"name": "Holiday"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create album = %d, body=%s", create.Code, create.Body.String())
	}
	var createdAlbum struct {
		Album struct {
			ID string `json:"id"`
		} `json:"album"`
	}
	if err := json.Unmarshal(create.Body.Bytes(), &createdAlbum); err != nil {
		t.Fatalf("unmarshal album: %v", err)
	}
	albumID := createdAlbum.Album.ID

	rec := admin.do(t, http.MethodPost,
		"/api/v1/libraries/"+libID+"/albums/"+albumID+"/files/"+inAlbum, nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("add file to album = %d, body=%s", rec.Code, rec.Body.String())
	}

	albumKey := authz.EntityKey("a", libID, albumID)
	rec = admin.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/shares",
		map[string]any{"key": albumKey, "caps": []string{"read"}})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create album share = %d, body=%s", rec.Code, rec.Body.String())
	}
	var shared struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &shared); err != nil {
		t.Fatalf("unmarshal share: %v", err)
	}

	// Listing the share resolves to the album's own files, not an empty
	// folder listing — the bug this test guards against.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/shares/"+shared.Token+"/files", nil)
	rr := httptest.NewRecorder()
	admin.handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("album share list = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	var listed struct {
		Files []struct {
			ID string `json:"id"`
		} `json:"files"`
		Total int `json:"total"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &listed); err != nil {
		t.Fatalf("unmarshal list: %v", err)
	}
	if listed.Total != 1 || len(listed.Files) != 1 || listed.Files[0].ID != inAlbum {
		t.Fatalf("album share list = %+v, want exactly [%s]", listed, inAlbum)
	}

	// The member file resolves.
	req = httptest.NewRequest(http.MethodGet,
		"/api/v1/shares/"+shared.Token+"/files/"+inAlbum, nil)
	rr = httptest.NewRecorder()
	admin.handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("album share get member file = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}

	// A file that merely lives in the same library, but was never added to
	// the album, must not be reachable through the album's share.
	req = httptest.NewRequest(http.MethodGet,
		"/api/v1/shares/"+shared.Token+"/files/"+outsideAlbum, nil)
	rr = httptest.NewRecorder()
	admin.handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("album share get non-member file = %d, want 403", rr.Code)
	}

	// Read is not download: the share was only granted "read".
	req = httptest.NewRequest(http.MethodGet,
		"/api/v1/shares/"+shared.Token+"/files/"+inAlbum+"/download", nil)
	rr = httptest.NewRecorder()
	admin.handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("album share download without the cap = %d, want 403", rr.Code)
	}
}

// A public page renders thumbnails as `<img>` tags, which cannot carry the
// share's password header — so the password travels as a query parameter
// instead for exactly this route (resolveShare's fallback). This proves both
// that fallback and that the thumbnail itself is real, decodable JPEG bytes.
func TestAuthz_PublicShareThumbnail(t *testing.T) {
	_, admin, _, libID := newAuthzTestServer(t)
	fileID := uploadJPEG(t, admin, libID, "photos/sunset.jpg")

	rec := admin.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/shares",
		map[string]any{
			"key":      authz.FolderKey(libID, "photos"),
			"caps":     []string{"read"},
			"password": "sekrit-pass",
		})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create share = %d, body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal share: %v", err)
	}

	// No password anywhere — denied, same as every other share route.
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/shares/"+resp.Token+"/files/"+fileID+"/thumbnail", nil)
	rr := httptest.NewRecorder()
	admin.handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("thumbnail without password = %d, want 401", rr.Code)
	}

	// The header still works (JSON clients, the existing convention).
	req = httptest.NewRequest(http.MethodGet,
		"/api/v1/shares/"+resp.Token+"/files/"+fileID+"/thumbnail", nil)
	req.Header.Set(sharePasswordHeader, "sekrit-pass")
	rr = httptest.NewRecorder()
	admin.handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("thumbnail with header = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}

	// And so does the query parameter — what an <img src> actually sends.
	req = httptest.NewRequest(http.MethodGet,
		"/api/v1/shares/"+resp.Token+"/files/"+fileID+"/thumbnail?password=sekrit-pass", nil)
	rr = httptest.NewRecorder()
	admin.handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("thumbnail with query password = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	if ct := rr.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Errorf("content-type = %q, want image/jpeg", ct)
	}
	body := rr.Body.Bytes()
	if !bytes.HasPrefix(body, []byte{0xff, 0xd8, 0xff}) {
		t.Error("served thumbnail is not a JPEG")
	}
	if _, _, err := image.Decode(bytes.NewReader(body)); err != nil {
		t.Errorf("served thumbnail does not decode: %v", err)
	}
}

// A folder share must be fully self-describing from its token alone — no
// `?folder=` query param should be required to see the folder's own
// contents, since nothing before this test ever set one.
func TestAuthz_PublicFolderShareSelfDescribing(t *testing.T) {
	_, admin, _, libID := newAuthzTestServer(t)
	inFolder := uploadFile(t, admin, libID, "trip/2024/photo.jpg")
	outsideFolder := uploadFile(t, admin, libID, "other/photo.jpg")

	rec := admin.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/shares",
		map[string]any{"key": authz.FolderKey(libID, "trip/2024"), "caps": []string{"read"}})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create folder share = %d, body=%s", rec.Code, rec.Body.String())
	}
	var shared struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &shared); err != nil {
		t.Fatalf("unmarshal share: %v", err)
	}

	infoReq := httptest.NewRequest(http.MethodGet, "/api/v1/shares/"+shared.Token, nil)
	infoRR := httptest.NewRecorder()
	admin.handler.ServeHTTP(infoRR, infoReq)
	var info struct {
		Share struct {
			ResourceType string `json:"resource_type"`
		} `json:"share"`
	}
	if err := json.Unmarshal(infoRR.Body.Bytes(), &info); err != nil {
		t.Fatalf("unmarshal share info: %v", err)
	}
	if info.Share.ResourceType != "folder" {
		t.Fatalf("resource_type = %q, want folder", info.Share.ResourceType)
	}

	// No ?folder= query param — the share key alone must resolve it.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/shares/"+shared.Token+"/files", nil)
	rr := httptest.NewRecorder()
	admin.handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("folder share list = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	var listed struct {
		Files []struct {
			ID string `json:"id"`
		} `json:"files"`
		Total int `json:"total"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &listed); err != nil {
		t.Fatalf("unmarshal list: %v", err)
	}
	if listed.Total != 1 || len(listed.Files) != 1 || listed.Files[0].ID != inFolder {
		t.Fatalf("folder share list = %+v, want exactly [%s]", listed, inFolder)
	}

	// A file outside the shared folder must not be reachable by id either.
	req = httptest.NewRequest(http.MethodGet,
		"/api/v1/shares/"+shared.Token+"/files/"+outsideFolder, nil)
	rr = httptest.NewRecorder()
	admin.handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("folder share non-member file = %d, want 403", rr.Code)
	}
}

// A single-file share must resolve to exactly that file from the token
// alone, the same way album/memory shares resolve from membership.
func TestAuthz_PublicFileShare(t *testing.T) {
	_, admin, _, libID := newAuthzTestServer(t)
	fileID := uploadFile(t, admin, libID, "trip/photo.jpg")

	rec := admin.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/shares",
		map[string]any{"key": authz.FileKey(libID, "trip/photo.jpg"), "caps": []string{"read", "download"}})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create file share = %d, body=%s", rec.Code, rec.Body.String())
	}
	var shared struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &shared); err != nil {
		t.Fatalf("unmarshal share: %v", err)
	}

	infoReq := httptest.NewRequest(http.MethodGet, "/api/v1/shares/"+shared.Token, nil)
	infoRR := httptest.NewRecorder()
	admin.handler.ServeHTTP(infoRR, infoReq)
	var info struct {
		Share struct {
			ResourceType string `json:"resource_type"`
		} `json:"share"`
	}
	if err := json.Unmarshal(infoRR.Body.Bytes(), &info); err != nil {
		t.Fatalf("unmarshal share info: %v", err)
	}
	if info.Share.ResourceType != "file" {
		t.Fatalf("resource_type = %q, want file", info.Share.ResourceType)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/shares/"+shared.Token+"/files", nil)
	rr := httptest.NewRecorder()
	admin.handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("file share list = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	var listed struct {
		Files []struct {
			ID string `json:"id"`
		} `json:"files"`
		Total int `json:"total"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &listed); err != nil {
		t.Fatalf("unmarshal list: %v", err)
	}
	if listed.Total != 1 || len(listed.Files) != 1 || listed.Files[0].ID != fileID {
		t.Fatalf("file share list = %+v, want exactly [%s]", listed, fileID)
	}

	dl := httptest.NewRequest(http.MethodGet, "/api/v1/shares/"+shared.Token+"/files/"+fileID+"/download", nil)
	dlRR := httptest.NewRecorder()
	admin.handler.ServeHTTP(dlRR, dl)
	if dlRR.Code != http.StatusOK {
		t.Fatalf("file share download = %d, want 200 (body=%s)", dlRR.Code, dlRR.Body.String())
	}
}

// A memory share exposes the referenced photos through the same
// files/{id}/download and thumbnail routes every other share scope uses,
// gated by membership in the memory's own image blocks — not by the
// visitor's access to the rest of the library.
func TestAuthz_PublicMemoryShare(t *testing.T) {
	_, admin, _, libID := newAuthzTestServer(t)
	inMemory := uploadJPEG(t, admin, libID, "trip/cover.jpg")
	outsideMemory := uploadJPEG(t, admin, libID, "trip/other.jpg")

	create := admin.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/memories",
		map[string]any{
			"title": "Trip",
			"blocks": []map[string]any{
				{"type": "image", "images": []map[string]string{{"file_id": inMemory}}},
			},
		})
	if create.Code != http.StatusCreated {
		t.Fatalf("create memory = %d, body=%s", create.Code, create.Body.String())
	}
	var createdMemory struct {
		Memory struct {
			ID string `json:"id"`
		} `json:"memory"`
	}
	if err := json.Unmarshal(create.Body.Bytes(), &createdMemory); err != nil {
		t.Fatalf("unmarshal memory: %v", err)
	}
	memoryID := createdMemory.Memory.ID

	memKey := authz.EntityKey("m", libID, memoryID)
	rec := admin.do(t, http.MethodPost, "/api/v1/libraries/"+libID+"/shares",
		map[string]any{"key": memKey, "caps": []string{"read", "download"}})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create memory share = %d, body=%s", rec.Code, rec.Body.String())
	}
	var shared struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &shared); err != nil {
		t.Fatalf("unmarshal share: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/shares/"+shared.Token+"/memory", nil)
	rr := httptest.NewRecorder()
	admin.handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("public memory get = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	var doc struct {
		Memory struct {
			Blocks []struct {
				Images []struct {
					FileID string `json:"file_id"`
					Media  struct {
						Available    bool   `json:"available"`
						ThumbnailURL string `json:"thumbnail_url"`
						OriginalURL  string `json:"original_url"`
					} `json:"media"`
				} `json:"images"`
			} `json:"blocks"`
		} `json:"memory"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &doc); err != nil {
		t.Fatalf("unmarshal public memory: %v", err)
	}
	if len(doc.Memory.Blocks) != 1 || len(doc.Memory.Blocks[0].Images) != 1 {
		t.Fatalf("public memory blocks = %+v, want one image block with one image", doc.Memory.Blocks)
	}
	img := doc.Memory.Blocks[0].Images[0]
	if img.FileID != inMemory || !img.Media.Available {
		t.Fatalf("public memory image = %+v, want available member %s", img, inMemory)
	}
	wantPrefix := "/api/v1/shares/" + shared.Token + "/files/" + inMemory
	if img.Media.ThumbnailURL != wantPrefix+"/thumbnail" || img.Media.OriginalURL != wantPrefix+"/download" {
		t.Fatalf("public memory image urls = %+v, want share-relative %s", img.Media, wantPrefix)
	}

	// The referenced file resolves through the generic file routes, gated
	// by memory membership rather than a separate per-file grant.
	thumb := httptest.NewRequest(http.MethodGet,
		"/api/v1/shares/"+shared.Token+"/files/"+inMemory+"/thumbnail", nil)
	thumbRR := httptest.NewRecorder()
	admin.handler.ServeHTTP(thumbRR, thumb)
	if thumbRR.Code != http.StatusOK {
		t.Fatalf("memory share thumbnail = %d, want 200 (body=%s)", thumbRR.Code, thumbRR.Body.String())
	}

	// A file that merely lives in the same library, but is not referenced
	// by this memory, must not be reachable through the memory's share.
	denied := httptest.NewRequest(http.MethodGet,
		"/api/v1/shares/"+shared.Token+"/files/"+outsideMemory+"/download", nil)
	deniedRR := httptest.NewRecorder()
	admin.handler.ServeHTTP(deniedRR, denied)
	if deniedRR.Code != http.StatusForbidden {
		t.Fatalf("memory share non-member file = %d, want 403", deniedRR.Code)
	}
}
