package httpapi

import (
	"database/sql"
	"log/slog"
	"net/http"
)

// Server is the Cairn HTTP application. It is a small composition of the
// routes and shared dependencies; individual handlers stay in their own
// files.
type Server struct {
	logger *slog.Logger
	db     *sql.DB
	web    http.Handler
}

// Dependencies are the services the HTTP layer needs. Keeping them explicit
// here makes the API testable in isolation and prevents hidden globals.
type Dependencies struct {
	Logger *slog.Logger
	DB     *sql.DB
	// WebUI serves the embedded (or overridden) frontend at "/". It may be
	// nil, in which case API routes still work but the web UI is unavailable.
	WebUI http.Handler
}

// New returns a Server built from the given dependencies. The caller must
// call Handler() to obtain the http.Handler.
func New(deps Dependencies) *Server {
	return &Server{
		logger: deps.Logger,
		db:     deps.DB,
		web:    deps.WebUI,
	}
}

// Handler builds the fully-middlware-wrapped http.Handler for this Server.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/v1/health", s.handleHealth)
	mux.HandleFunc("GET /api/v1/version", s.handleVersion)
	mux.Handle("/api/", s.handleAPIUnknown())

	if s.web != nil {
		mux.Handle("/", s.web)
	} else {
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			writeError(w, s.logger, requestIDOrEmpty(r), http.StatusNotFound, CodeNotFound,
				"No web frontend is configured. Build the frontend or point CAIRN_WEB_DIST at a built web/dist directory.")
		})
	}

	return WithMiddleware(s.logger, mux)
}

// handleAPIUnknown returns a JSON 404 for any unmatched /api/ request,
// keeping API errors consistent regardless of the path.
func (s *Server) handleAPIUnknown() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeErrorf(w, s.logger, requestIDOrEmpty(r), http.StatusNotFound, CodeNotFound,
			"No such API route: %s %s.", r.Method, r.URL.Path)
	})
}
