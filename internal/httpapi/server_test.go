package httpapi

import (
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Jishnu-Prasad888/Cairn/internal/db"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// newTestServer builds a fully wired Server backed by a fresh temporary SQLite
// database, and returns its top-level http.Handler.
func newTestServer(t *testing.T) (http.Handler, *sql.DB) {
	t.Helper()
	pool, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	t.Cleanup(func() { _ = pool.Close() })
	if err := db.Migrate(pool); err != nil {
		t.Fatalf("migrate test database: %v", err)
	}
	srv := New(Dependencies{Logger: testLogger(), DB: pool})
	return srv.Handler(), pool
}

func doJSON(t *testing.T, h http.Handler, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestHealthOK(t *testing.T) {
	handler, _ := newTestServer(t)
	rec := doJSON(t, handler, http.MethodGet, "/api/v1/health")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("content type = %q", ct)
	}

	var body struct {
		Status string `json:"status"`
		DB     string `json:"database"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body.Status != "ok" || body.DB != "ok" {
		t.Errorf("body = %+v, want status=ok database=ok", body)
	}
}

func TestHealthDegradedWhenDatabaseDown(t *testing.T) {
	handler, pool := newTestServer(t)
	_ = pool.Close() // simulate database failure

	rec := doJSON(t, handler, http.MethodGet, "/api/v1/health")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (health reports degraded state)", rec.Code)
	}

	var body struct {
		Status string `json:"status"`
		DB     string `json:"database"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body.Status != "degraded" || body.DB != "error" {
		t.Errorf("body = %+v, want degraded/error", body)
	}
}

func TestVersionEndpoint(t *testing.T) {
	handler, _ := newTestServer(t)
	rec := doJSON(t, handler, http.MethodGet, "/api/v1/version")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, field := range []string{"version", "commit", "build_date", "go_version", "platform"} {
		if v, ok := body[field]; !ok || v == "" {
			t.Errorf("version response missing %q", field)
		}
	}
}

func TestUnknownAPIRouteReturnsJSONNotFound(t *testing.T) {
	handler, _ := newTestServer(t)

	cases := []string{
		"/api/v1/totally-missing",
		"/api/v1/health/extra",
		"/api/",
		"/api/v2/health",
	}
	for _, path := range cases {
		rec := doJSON(t, handler, http.MethodGet, path)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", path, rec.Code)
			continue
		}
		assertErrorEnvelope(t, rec, http.StatusNotFound, CodeNotFound)
	}
}

func TestWrongMethodOnAPIEndpoint(t *testing.T) {
	handler, _ := newTestServer(t)
	rec := doJSON(t, handler, http.MethodPost, "/api/v1/health")

	// The API error envelope is still JSON even when the method is not
	// supported for the route.
	assertErrorEnvelope(t, rec, http.StatusNotFound, CodeNotFound)
}

func TestNonAPIUnknownRoute(t *testing.T) {
	// Without a web handler mounted, non-API routes must return JSON 404, not
	// a Go ServeMux plain-text response.
	handler, _ := newTestServer(t)
	rec := doJSON(t, handler, http.MethodGet, "/does/not/exist")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	assertErrorEnvelope(t, rec, http.StatusNotFound, CodeNotFound)
}

// assertErrorEnvelope asserts that the recorder holds a valid JSON error
// envelope with the expected status and code.
func assertErrorEnvelope(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d", rec.Code, status)
	}

	var env ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("error response is not JSON: %v (body=%q)", err, rec.Body.String())
	}
	if env.Error.Code != code {
		t.Errorf("error code = %q, want %q", env.Error.Code, code)
	}
	if env.Error.Message == "" {
		t.Error("error message is empty")
	}
}

func TestErrorsCarryRequestID(t *testing.T) {
	handler, _ := newTestServer(t)
	rec := doJSON(t, handler, http.MethodGet, "/api/v1/does-not-exist")

	var env ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Error.RequestID == "" {
		t.Error("error response has no request_id")
	}
	if rec.Header().Get("X-Request-ID") == "" {
		t.Error("response is missing X-Request-ID header")
	}
	if env.Error.RequestID != rec.Header().Get("X-Request-ID") {
		t.Error("error request_id does not match X-Request-ID header")
	}
}

func TestClientSuppliedRequestIDIsUsed(t *testing.T) {
	handler, _ := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	req.Header.Set("X-Request-ID", "abc-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("X-Request-ID"); got != "abc-123" {
		t.Errorf("X-Request-ID = %q, want client value", got)
	}
}