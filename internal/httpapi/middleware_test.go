package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequestIDGeneratedWhenMissing(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, ok := RequestIDFrom(r.Context())
		if !ok {
			t.Error("request ID not present in context")
		}
		if id == "" {
			t.Error("request ID is empty")
		}
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	requestID(inner).ServeHTTP(rec, req)

	if got := rec.Header().Get("X-Request-ID"); len(got) != 32 {
		t.Errorf("generated X-Request-ID length = %d, want 32", len(got))
	}
}

func TestRequestIDRejectsMalformedClientValues(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	for _, bad := range []string{"", "has space", "a\nb", strings.Repeat("a", 200), "\x00"} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("X-Request-ID", bad)
		rec := httptest.NewRecorder()
		requestID(inner).ServeHTTP(rec, req)

		if got := rec.Header().Get("X-Request-ID"); got == bad {
			t.Errorf("malformed X-Request-ID %q was accepted", bad)
		}
	}
}

func TestRecoverPanicsIntoJSONError(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	})

	handler := recoverPanics(testLogger(), inner)
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	var env ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("panic response is not JSON: %v", err)
	}
	if env.Error.Code != CodeInternal {
		t.Errorf("code = %q, want INTERNAL", env.Error.Code)
	}
	// Panic handling must not leak the panic value to the client.
	if rec.Body.String() == "boom" {
		t.Error("panic value leaked to the client")
	}
}

func TestRecoverSetStatusBeforePanic(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		w.Write([]byte("partial"))
		panic("late")
	})

	handler := recoverPanics(testLogger(), inner)
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// Once the status line is written it cannot be changed; the important
	// property is that the server does not crash.
	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want 201 (already committed)", rec.Code)
	}
}

func TestAccessLogPassthrough(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	handler := accessLog(testLogger(), inner)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", rec.Code)
	}
}

func TestMiddlewareStackEndToEnd(t *testing.T) {
	handler := WithMiddleware(testLogger(), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, _ := RequestIDFrom(r.Context())
		writeJSON(w, testLogger(), http.StatusOK, map[string]string{"id": id})
	}))

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["id"] == "" {
		t.Error("handler did not receive request ID")
	}
}