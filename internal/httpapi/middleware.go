package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"time"
)

// maxRequestIDLen bounds the length of client-supplied request IDs so the log
// and response headers cannot be abused as a memory sink.
const maxRequestIDLen = 128

// WithMiddleware wraps the given handler in the standard middleware stack:
// request IDs, panic recovery, and access logging. The stack runs in the
// order listed here, so recovery wraps the application handler most closely.
func WithMiddleware(logger *slog.Logger, next http.Handler) http.Handler {
	return requestID(recoverPanics(logger, accessLog(logger, next)))
}

// requestID ensures every request has a request ID, preferring a
// well-formed client-supplied X-Request-ID header and otherwise generating a
// random one. The ID is stored in the request context and echoed back on the
// response.
func requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if !validRequestID(id) {
			id = newRequestID()
		}
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r.WithContext(WithRequestID(r.Context(), id)))
	})
}

// newRequestID returns a hex-encoded 128-bit random identifier.
func newRequestID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "unknown"
	}
	return hex.EncodeToString(b[:])
}

func validRequestID(id string) bool {
	if len(id) == 0 || len(id) > maxRequestIDLen {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == ':':
		default:
			return false
		}
	}
	return true
}

// recoverPanics converts panics in downstream handlers into JSON 500 errors.
// The request is never allowed to die with an empty or partial response.
func recoverPanics(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				requestID := requestIDOrEmpty(r)
				logger.Error("panic in handler",
					"panic", v,
					"request_id", requestID,
					"method", r.Method,
					"path", r.URL.Path,
				)
				// If the handler already started writing, the status code
				// cannot be changed; the panic is reported to the client only
				// when possible.
				writeError(w, logger, requestID, http.StatusInternalServerError, CodeInternal, "Internal server error.")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// accessLog emits one structured log line per request after it completes.
func accessLog(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)

		logger.Info("http request",
			"request_id", requestIDOrEmpty(r),
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"duration_ms", time.Since(start).Milliseconds(),
			"remote", r.RemoteAddr,
		)
	})
}

// statusRecorder captures the response status code for access logging.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func requestIDOrEmpty(r *http.Request) string {
	id, _ := RequestIDFrom(r.Context())
	return id
}
