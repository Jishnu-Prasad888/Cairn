package httpapi

import (
	"errors"
	"net/http"

	"github.com/Jishnu-Prasad888/Cairn/internal/auth"
	"github.com/Jishnu-Prasad888/Cairn/internal/usersettings"
)

// handleGetMemorySettings — GET /api/v1/settings/memories
//
// Returns the caller's Memories preferences with defaults filled in.
func (s *Server) handleGetMemorySettings(w http.ResponseWriter, r *http.Request, u *auth.User) {
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"settings": s.memorySettingsFor(r.Context(), u)})
}

// handleUpdateMemorySettings — PATCH /api/v1/settings/memories
//
// Updates any subset of the caller's Memories preferences.
func (s *Server) handleUpdateMemorySettings(w http.ResponseWriter, r *http.Request, u *auth.User) {
	if s.db == nil {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusServiceUnavailable,
			CodeServiceUnavailable, "Settings storage is unavailable.")
		return
	}
	var patch usersettings.MemoryPatch
	if err := readJSON(w, r, &patch); err != nil {
		writeDomainError(w, s.logger, requestIDOrEmpty(r), err)
		return
	}
	settings, err := usersettings.NewStore(s.db).UpdateMemory(r.Context(), u.ID, patch)
	var ve *usersettings.ValidationError
	switch {
	case errors.As(err, &ve):
		s.badRequest(w, r, ve.Error())
	case err != nil:
		s.logger.Error("update memory settings", "user_id", u.ID, "error", err)
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to save settings.")
	default:
		writeJSON(w, s.logger, http.StatusOK, map[string]any{"settings": settings})
	}
}

// handleGetAlbumSettings — GET /api/v1/settings/albums
//
// The caller's Albums page preferences: sort, pinned albums, hidden libraries.
func (s *Server) handleGetAlbumSettings(w http.ResponseWriter, r *http.Request, u *auth.User) {
	settings := usersettings.DefaultAlbumSettings()
	if s.db != nil {
		got, err := usersettings.NewStore(s.db).Albums(r.Context(), u.ID)
		if err != nil {
			s.logger.Error("read album settings", "user_id", u.ID, "error", err)
		} else {
			settings = got
		}
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"settings": settings})
}

// handleUpdateAlbumSettings — PATCH /api/v1/settings/albums
func (s *Server) handleUpdateAlbumSettings(w http.ResponseWriter, r *http.Request, u *auth.User) {
	if s.db == nil {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusServiceUnavailable,
			CodeServiceUnavailable, "Settings storage is unavailable.")
		return
	}
	var patch usersettings.AlbumPatch
	if err := readJSON(w, r, &patch); err != nil {
		writeDomainError(w, s.logger, requestIDOrEmpty(r), err)
		return
	}
	settings, err := usersettings.NewStore(s.db).UpdateAlbums(r.Context(), u.ID, patch)
	var ve *usersettings.ValidationError
	switch {
	case errors.As(err, &ve):
		s.badRequest(w, r, ve.Error())
	case err != nil:
		s.logger.Error("update album settings", "user_id", u.ID, "error", err)
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to save settings.")
	default:
		writeJSON(w, s.logger, http.StatusOK, map[string]any{"settings": settings})
	}
}
