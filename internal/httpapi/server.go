package httpapi

import (
	"database/sql"
	"log/slog"
	"net/http"

	"github.com/Jishnu-Prasad888/Cairn/internal/auth"
	"github.com/Jishnu-Prasad888/Cairn/internal/indexer"
	"github.com/Jishnu-Prasad888/Cairn/internal/library"
)

// Server is the Cairn HTTP application. It is a small composition of the
// routes and shared dependencies; individual handlers stay in their own
// files.
type Server struct {
	logger        *slog.Logger
	db            *sql.DB
	web           http.Handler
	auth          *auth.Service
	libraries     *library.Manager
	indexer       *indexer.IndexManager
	secureCookies bool
}

// Dependencies are the services the HTTP layer needs. Keeping them explicit
// here makes the API testable in isolation and prevents hidden globals.
type Dependencies struct {
	Logger *slog.Logger
	DB     *sql.DB
	// Auth resolves principals from sessions. It may be nil, in which case the
	// protected authentication and user-management endpoints return
	// UNAUTHORIZED.
	Auth *auth.Service
	// Libraries registers and reconciles storage libraries. It may be nil, in
	// which case the library-management endpoints return INTERNAL.
	Libraries *library.Manager
	// Indexer manages per-library scan jobs and index status. It may be nil,
	// in which case the indexing endpoints return SERVICE_UNAVAILABLE.
	Indexer *indexer.IndexManager
	// SecureCookies forces the Secure flag on session cookies even when the
	// server did not observe TLS (e.g. behind a TLS-terminating proxy).
	SecureCookies bool
	// WebUI serves the embedded (or overridden) frontend at "/". It may be
	// nil, in which case API routes still work but the web UI is unavailable.
	WebUI http.Handler
}

// New returns a Server built from the given dependencies. The caller must
// call Handler() to obtain the http.Handler.
func New(deps Dependencies) *Server {
	return &Server{
		logger:        deps.Logger,
		db:            deps.DB,
		web:           deps.WebUI,
		auth:          deps.Auth,
		libraries:     deps.Libraries,
		indexer:       deps.Indexer,
		secureCookies: deps.SecureCookies,
	}
}

// Handler builds the fully-middleware-wrapped http.Handler for this Server.
//
// Route policy: everything under /api/v1/ is registered explicitly; health,
// version, auth bootstrap/status/login are public, and the remaining auth and
// user-management routes require a session (admin role where noted). Unknown
// /api/ routes still receive the JSON 404 envelope.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/v1/health", s.handleHealth)
	mux.HandleFunc("GET /api/v1/version", s.handleVersion)

	// Public authentication surface.
	mux.HandleFunc("GET /api/v1/auth/status", s.handleAuthStatus)
	mux.HandleFunc("POST /api/v1/auth/bootstrap", s.handleBootstrap)
	mux.HandleFunc("POST /api/v1/auth/login", s.handleLogin)

	// Session-required surface.
	mux.HandleFunc("POST /api/v1/auth/logout", s.requireSession(s.handleLogout))
	mux.Handle("GET /api/v1/auth/me", s.withAuth(allowAny, s.handleMe))

	// Admin surface.
	mux.Handle("GET /api/v1/users", s.withAuth(allowAdmin, s.handleListUsers))
	mux.Handle("POST /api/v1/users", s.withAuth(allowAdmin, s.handleCreateUser))
	mux.Handle("POST /api/v1/users/{id}/sessions/revoke", s.withAuth(allowAdmin, s.handleRevokeUserSessions))

	// Library surface (admin). Management is gated like user management until
	// resource-based authorization (Phase 9) generalizes it.
	if s.libraries != nil {
		mux.Handle("GET /api/v1/libraries", s.withAuth(allowAdmin, s.handleListLibraries))
		mux.Handle("POST /api/v1/libraries", s.withAuth(allowAdmin, s.handleCreateLibrary))
		mux.Handle("POST /api/v1/libraries/probe", s.withAuth(allowAdmin, s.handleProbeLibrary))
		mux.Handle("GET /api/v1/libraries/{id}", s.withAuth(allowAdmin, s.handleGetLibrary))
		mux.Handle("POST /api/v1/libraries/{id}/refresh", s.withAuth(allowAdmin, s.handleRefreshLibrary))
		mux.Handle("DELETE /api/v1/libraries/{id}", s.withAuth(allowAdmin, s.handleDeleteLibrary))
		// Indexing surface (admin).
		mux.Handle("POST /api/v1/libraries/{id}/index", s.withAuth(allowAdmin, s.handleTriggerIndex))
		mux.Handle("GET /api/v1/libraries/{id}/index/status", s.withAuth(allowAdmin, s.handleIndexStatus))

		// Media/files surface (admin until Phase 9 resource-based authz).
		mux.Handle("GET /api/v1/libraries/{id}/files", s.withAuth(allowAdmin, s.handleListFiles))
		mux.Handle("GET /api/v1/libraries/{id}/files/{fileID}", s.withAuth(allowAdmin, s.handleGetFile))
		mux.Handle("GET /api/v1/libraries/{id}/files/{fileID}/download", s.withAuth(allowAdmin, s.handleDownloadFile))
		mux.Handle("POST /api/v1/libraries/{id}/files/upload", s.withAuth(allowAdmin, s.handleUploadFile))
		mux.Handle("POST /api/v1/libraries/{id}/files/{fileID}/rename", s.withAuth(allowAdmin, s.handleRenameFile))
		mux.Handle("POST /api/v1/libraries/{id}/files/{fileID}/move", s.withAuth(allowAdmin, s.handleMoveFile))
		mux.Handle("POST /api/v1/libraries/{id}/files/{fileID}/copy", s.withAuth(allowAdmin, s.handleCopyFile))
		mux.Handle("DELETE /api/v1/libraries/{id}/files/{fileID}", s.withAuth(allowAdmin, s.handleDeleteFile))
		mux.Handle("POST /api/v1/libraries/{id}/files/{fileID}/restore", s.withAuth(allowAdmin, s.handleRestoreFile))
		mux.Handle("DELETE /api/v1/libraries/{id}/files/{fileID}/permanent", s.withAuth(allowAdmin, s.handlePermanentDeleteFile))
		mux.Handle("GET /api/v1/libraries/{id}/files/{fileID}/metadata", s.withAuth(allowAdmin, s.handleGetFileMetadata))
		mux.Handle("GET /api/v1/libraries/{id}/files/{fileID}/thumbnail", s.withAuth(allowAdmin, s.handleGetThumbnail))

		// Folders and trash.
		mux.Handle("GET /api/v1/libraries/{id}/folders", s.withAuth(allowAdmin, s.handleListFolders))
		mux.Handle("GET /api/v1/libraries/{id}/trash", s.withAuth(allowAdmin, s.handleListTrash))
	}

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

// requireSession wraps a plain http.HandlerFunc with authentication. The
// session is authenticated and discarded; handlers that need the principal use
// withAuth instead.
func (s *Server) requireSession(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := s.currentUser(w, r); !ok {
			return
		}
		next(w, r)
	}
}

// handleAPIUnknown returns a JSON 404 for any unmatched /api/ request,
// keeping API errors consistent regardless of the path.
func (s *Server) handleAPIUnknown() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeErrorf(w, s.logger, requestIDOrEmpty(r), http.StatusNotFound, CodeNotFound,
			"No such API route: %s %s.", r.Method, r.URL.Path)
	})
}
