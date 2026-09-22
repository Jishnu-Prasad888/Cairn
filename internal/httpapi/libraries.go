package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/auth"
	"github.com/Jishnu-Prasad888/Cairn/internal/authz"
	"github.com/Jishnu-Prasad888/Cairn/internal/library"
)

// libraryRequest is the accepted create/adopt payload.
type libraryRequest struct {
	Path string `json:"path"`
	Name string `json:"name,omitempty"`
}

// probeRequest is the accepted probe payload.
type probeRequest struct {
	Path string `json:"path"`
}

// refreshRequest is the accepted refresh/reconnect payload; Path is optional
// and, when supplied, reconnects the library at the new location.
type refreshRequest struct {
	Path string `json:"path,omitempty"`
}

// toLibraryResponse is the API representation of a library without internal ids.
type libraryResponse struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Root          string `json:"root"`
	Status        string `json:"status"`
	VolumeID      string `json:"volume_id,omitempty"`
	SchemaVersion int    `json:"schema_version"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
}

func toLibraryResponse(l *library.Library) libraryResponse {
	return libraryResponse{
		ID:            l.ID,
		Name:          l.Name,
		Root:          l.Root,
		Status:        string(l.Status),
		VolumeID:      l.VolumeID,
		SchemaVersion: l.SchemaVersion,
		CreatedAt:     l.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:     l.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

// actorCtx stamps the request context with the authenticated principal so
// library audit records capture who acted. Handlers use it for every call.
func actorCtx(r *http.Request, u *auth.User) *http.Request {
	if u == nil {
		return r
	}
	return r.WithContext(library.WithActor(r.Context(), u.ID))
}

// handleProbeLibrary inspects a candidate path without registering it. Admin
// only; read-only on both the filesystem and the registrar.
func (s *Server) handleProbeLibrary(w http.ResponseWriter, r *http.Request, u *auth.User) {
	var body probeRequest
	if err := readJSON(w, r, &body); err != nil {
		writeDomainError(w, s.logger, requestIDOrEmpty(r), err)
		return
	}
	result, err := s.libraries.Probe(actorCtx(r, u).Context(), body.Path)
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"probe": result})
}

// handleCreateLibrary registers a library, creating fresh metadata or adopting
// an existing one. Admin only.
func (s *Server) handleCreateLibrary(w http.ResponseWriter, r *http.Request, u *auth.User) {
	var body libraryRequest
	if err := readJSON(w, r, &body); err != nil {
		writeDomainError(w, s.logger, requestIDOrEmpty(r), err)
		return
	}
	lib, mode, err := s.libraries.Register(actorCtx(r, u).Context(), body.Path, body.Name)
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	writeJSON(w, s.logger, http.StatusCreated, map[string]any{
		"library": toLibraryResponse(lib),
		"mode":    mode,
	})
}

// handleListLibraries returns all registered libraries. Admin only.
func (s *Server) handleListLibraries(w http.ResponseWriter, r *http.Request, _ *auth.User) {
	libs, err := s.libraries.List(r.Context())
	if err != nil {
		s.logger.Error("list libraries", "error", err)
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Internal server error.")
		return
	}
	resp := make([]libraryResponse, 0, len(libs))
	for i := range libs {
		resp = append(resp, toLibraryResponse(&libs[i]))
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"libraries": resp})
}

// handleGetLibrary returns a single library. Requires read on the library
// resource.
func (s *Server) handleGetLibrary(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, err := s.libraries.Get(actorCtx(r, u).Context(), r.PathValue("id"))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	if !s.requireCap(w, r, u, authz.LibraryKey(lib.ID), authz.CapRead) {
		return
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"library": toLibraryResponse(lib)})
}

// handleRefreshLibrary rechecks connectivity or, when a new path is supplied,
// reconnects the library there. Admin only.
func (s *Server) handleRefreshLibrary(w http.ResponseWriter, r *http.Request, u *auth.User) {
	var body refreshRequest
	if err := readJSON(w, r, &body); err != nil {
		writeDomainError(w, s.logger, requestIDOrEmpty(r), err)
		return
	}
	lib, err := s.libraries.Refresh(actorCtx(r, u).Context(), r.PathValue("id"), body.Path)
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"library": toLibraryResponse(lib)})
}

// handleDeleteLibrary unregisters a library, leaving its .cairn metadata in
// place. Admin only.
func (s *Server) handleDeleteLibrary(w http.ResponseWriter, r *http.Request, u *auth.User) {
	if err := s.libraries.Remove(actorCtx(r, u).Context(), r.PathValue("id")); err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// writeLibraryError maps library domain errors onto the JSON error envelope.
func (s *Server) writeLibraryError(w http.ResponseWriter, r *http.Request, err error) {
	requestID := requestIDOrEmpty(r)
	var ve *library.ValidationError
	switch {
	case errors.As(err, &ve):
		writeError(w, s.logger, requestID, http.StatusBadRequest, CodeBadRequest, ve.Error())
	case errors.Is(err, library.ErrExists):
		writeError(w, s.logger, requestID, http.StatusConflict, CodeConflict,
			"A library is already registered at that path.")
	case errors.Is(err, library.ErrNotFound):
		writeError(w, s.logger, requestID, http.StatusNotFound, CodeNotFound, "Library not found.")
	case errors.Is(err, library.ErrNoMetadata):
		writeError(w, s.logger, requestID, http.StatusBadRequest, CodeBadRequest,
			"No Cairn metadata was found at that path.")
	default:
		s.logger.Error("library error", "error", err)
		writeError(w, s.logger, requestID, http.StatusInternalServerError, CodeInternal,
			"Internal server error.")
	}
}
