package httpapi

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/auth"
	"github.com/Jishnu-Prasad888/Cairn/internal/authz"
	"github.com/Jishnu-Prasad888/Cairn/internal/fts"
	"github.com/Jishnu-Prasad888/Cairn/internal/library"
	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
	"github.com/Jishnu-Prasad888/Cairn/internal/markdown"
	"github.com/Jishnu-Prasad888/Cairn/internal/memories"
)

// openMemoryStore opens the per-library DB and returns a MemoryStore.
func (s *Server) openMemoryStore(
	w http.ResponseWriter, r *http.Request, lib *library.Library,
) (*memories.MemoryStore, func(), bool) {
	if lib.Status == library.StatusOffline {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusConflict,
			CodeConflict, "Library is offline.")
		return nil, nil, false
	}
	cairnDir := lib.Root + "/.cairn"
	db, err := librarydb.Open(cairnDir)
	if err != nil {
		s.logger.Error("open library db for memories", "library_id", lib.ID, "error", err)
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to open library database.")
		return nil, nil, false
	}
	return memories.NewMemoryStore(db), func() { _ = db.Close() }, true
}

// memoryResponse is the API representation of a memory.
type memoryResponse struct {
	ID         string  `json:"id"`
	Title      string  `json:"title"`
	Body       string  `json:"body"`
	MemoryDate *string `json:"memory_date,omitempty"`
	Deleted    bool    `json:"deleted"`
	CreatedAt  string  `json:"created_at"`
	UpdatedAt  string  `json:"updated_at"`
}

// memoryRefResponse is a single parsed internal reference, returned to clients
// so the UI can render links and bidirectional relations without reparsing.
type memoryRefResponse struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

func toMemoryResponse(m *memories.Memory) memoryResponse {
	resp := memoryResponse{
		ID:        m.ID,
		Title:     m.Title,
		Body:      m.Body,
		Deleted:   m.Deleted,
		CreatedAt: m.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt: m.UpdatedAt.UTC().Format(time.RFC3339),
	}
	if m.MemoryDate != nil {
		v := m.MemoryDate.UTC().Format(time.RFC3339)
		resp.MemoryDate = &v
	}
	return resp
}

func toMemoryResponses(ms []*memories.Memory) []memoryResponse {
	out := make([]memoryResponse, 0, len(ms))
	for _, m := range ms {
		out = append(out, toMemoryResponse(m))
	}
	return out
}

func toMemoryRefResponses(refs []markdown.Reference) []memoryRefResponse {
	out := make([]memoryRefResponse, 0, len(refs))
	for _, r := range refs {
		out = append(out, memoryRefResponse{Type: string(r.Type), ID: r.ID})
	}
	return out
}

// memoryListResponse wraps a page of memories with its next cursor.
type memoryListResponse struct {
	Memories []memoryResponse `json:"memories"`
	Next     string           `json:"next_cursor,omitempty"`
}

// handleListMemories — GET /api/v1/libraries/{id}/memories
//
// Supports limit/cursor pagination and, when ?q= is present, full-text search
// over titles and bodies.
func (s *Server) handleListMemories(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, err := s.libraries.Get(actorCtx(r, u).Context(), r.PathValue("id"))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	if !s.requireCap(w, r, u, authz.LibraryKey(lib.ID), authz.CapRead) {
		return
	}
	store, cleanup, ok := s.openMemoryStore(w, r, lib)
	if !ok {
		return
	}
	defer cleanup()

	q := r.URL.Query().Get("q")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	cursor := r.URL.Query().Get("cursor")

	var (
		ms   []*memories.Memory
		next string
	)
	if q != "" {
		ms, next, err = store.Search(r.Context(), q, cursor, limit)
	} else {
		ms, next, err = store.List(r.Context(), cursor, limit)
	}
	if err != nil {
		if errors.Is(err, fts.ErrInvalid) {
			writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest,
				CodeBadRequest, "Invalid search query.")
			return
		}
		s.logger.Error("list memories", "error", err)
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to list memories.")
		return
	}
	writeJSON(w, s.logger, http.StatusOK, memoryListResponse{
		Memories: toMemoryResponses(ms),
		Next:     next,
	})
}

// handleCreateMemory — POST /api/v1/libraries/{id}/memories
func (s *Server) handleCreateMemory(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, err := s.libraries.Get(actorCtx(r, u).Context(), r.PathValue("id"))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	if !s.requireCap(w, r, u, authz.LibraryKey(lib.ID), authz.CapCreate) {
		return
	}
	store, cleanup, ok := s.openMemoryStore(w, r, lib)
	if !ok {
		return
	}
	defer cleanup()

	var body struct {
		Title      string  `json:"title"`
		Body       string  `json:"body"`
		MemoryDate *string `json:"memory_date"`
	}
	if err := readJSON(w, r, &body); err != nil {
		writeDomainError(w, s.logger, requestIDOrEmpty(r), err)
		return
	}

	p := memories.CreateParams{Title: body.Title, Body: body.Body}
	if body.MemoryDate != nil {
		t, err := time.Parse(time.RFC3339, *body.MemoryDate)
		if err != nil {
			writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest,
				CodeBadRequest, "memory_date must be an RFC3339 timestamp.")
			return
		}
		p.MemoryDate = &t
	}

	m, err := store.Create(r.Context(), p)
	if err != nil {
		s.writeMemoryError(w, r, err)
		return
	}
	writeJSON(w, s.logger, http.StatusCreated, map[string]any{"memory": toMemoryResponse(m)})
}

// handleGetMemory — GET /api/v1/libraries/{id}/memories/{memoryID}
func (s *Server) handleGetMemory(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, err := s.libraries.Get(actorCtx(r, u).Context(), r.PathValue("id"))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	if !s.requireCap(w, r, u, authz.EntityKey("m", lib.ID, r.PathValue("memoryID")), authz.CapRead) {
		return
	}
	store, cleanup, ok := s.openMemoryStore(w, r, lib)
	if !ok {
		return
	}
	defer cleanup()

	m, err := store.Get(r.Context(), r.PathValue("memoryID"))
	if err != nil {
		s.writeMemoryError(w, r, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"memory": toMemoryResponse(m)})
}

// handleUpdateMemory — PUT /api/v1/libraries/{id}/memories/{memoryID}
//
// Autosaves from the editor are idempotent from the client's perspective:
// every save appends a version on the server.
func (s *Server) handleUpdateMemory(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, err := s.libraries.Get(actorCtx(r, u).Context(), r.PathValue("id"))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	if !s.requireCap(w, r, u, authz.EntityKey("m", lib.ID, r.PathValue("memoryID")), authz.CapEdit) {
		return
	}
	store, cleanup, ok := s.openMemoryStore(w, r, lib)
	if !ok {
		return
	}
	defer cleanup()

	var body struct {
		Title      string  `json:"title"`
		Body       string  `json:"body"`
		MemoryDate *string `json:"memory_date"`
		ClearDate  bool    `json:"clear_date"`
	}
	if err := readJSON(w, r, &body); err != nil {
		writeDomainError(w, s.logger, requestIDOrEmpty(r), err)
		return
	}

	p := memories.UpdateParams{
		Title:     body.Title,
		Body:      body.Body,
		ClearDate: body.ClearDate,
	}
	if body.MemoryDate != nil {
		t, err := time.Parse(time.RFC3339, *body.MemoryDate)
		if err != nil {
			writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest,
				CodeBadRequest, "memory_date must be an RFC3339 timestamp.")
			return
		}
		p.MemoryDate = &t
	}

	m, err := store.Update(r.Context(), r.PathValue("memoryID"), p)
	if err != nil {
		s.writeMemoryError(w, r, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"memory": toMemoryResponse(m)})
}

// handleDeleteMemory — DELETE /api/v1/libraries/{id}/memories/{memoryID}
func (s *Server) handleDeleteMemory(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, err := s.libraries.Get(actorCtx(r, u).Context(), r.PathValue("id"))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	if !s.requireCap(w, r, u, authz.EntityKey("m", lib.ID, r.PathValue("memoryID")), authz.CapDelete) {
		return
	}
	store, cleanup, ok := s.openMemoryStore(w, r, lib)
	if !ok {
		return
	}
	defer cleanup()

	if err := store.Delete(r.Context(), r.PathValue("memoryID")); err != nil {
		s.writeMemoryError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleRestoreMemory — POST /api/v1/libraries/{id}/memories/{memoryID}/restore
func (s *Server) handleRestoreMemory(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, err := s.libraries.Get(actorCtx(r, u).Context(), r.PathValue("id"))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	if !s.requireCap(w, r, u, authz.EntityKey("m", lib.ID, r.PathValue("memoryID")), authz.CapEdit) {
		return
	}
	store, cleanup, ok := s.openMemoryStore(w, r, lib)
	if !ok {
		return
	}
	defer cleanup()

	if err := store.Restore(r.Context(), r.PathValue("memoryID")); err != nil {
		s.writeMemoryError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// memoryVersionResponse is the API representation of a saved revision.
type memoryVersionResponse struct {
	MemoryID string `json:"memory_id"`
	Version  int    `json:"version"`
	Title    string `json:"title"`
	Body     string `json:"body"`
	SavedAt  string `json:"saved_at"`
}

func toVersionResponse(v *memories.MemoryVersion) memoryVersionResponse {
	return memoryVersionResponse{
		MemoryID: v.MemoryID,
		Version:  v.Version,
		Title:    v.Title,
		Body:     v.Body,
		SavedAt:  v.SavedAt.UTC().Format(time.RFC3339),
	}
}

func toVersionResponses(vs []*memories.MemoryVersion) []memoryVersionResponse {
	out := make([]memoryVersionResponse, 0, len(vs))
	for _, v := range vs {
		out = append(out, toVersionResponse(v))
	}
	return out
}

// handleListMemoryVersions — GET /api/v1/libraries/{id}/memories/{memoryID}/versions
func (s *Server) handleListMemoryVersions(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, err := s.libraries.Get(actorCtx(r, u).Context(), r.PathValue("id"))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	if !s.requireCap(w, r, u, authz.EntityKey("m", lib.ID, r.PathValue("memoryID")), authz.CapRead) {
		return
	}
	store, cleanup, ok := s.openMemoryStore(w, r, lib)
	if !ok {
		return
	}
	defer cleanup()

	vs, err := store.ListVersions(r.Context(), r.PathValue("memoryID"))
	if err != nil {
		s.writeMemoryError(w, r, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"versions": toVersionResponses(vs)})
}

// handleGetMemoryVersion — GET /api/v1/libraries/{id}/memories/{memoryID}/versions/{version}
func (s *Server) handleGetMemoryVersion(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, err := s.libraries.Get(actorCtx(r, u).Context(), r.PathValue("id"))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	if !s.requireCap(w, r, u, authz.EntityKey("m", lib.ID, r.PathValue("memoryID")), authz.CapRead) {
		return
	}
	store, cleanup, ok := s.openMemoryStore(w, r, lib)
	if !ok {
		return
	}
	defer cleanup()

	version, err := strconv.Atoi(r.PathValue("version"))
	if err != nil {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest,
			CodeBadRequest, "version must be an integer.")
		return
	}
	v, err := store.GetVersion(r.Context(), r.PathValue("memoryID"), version)
	if err != nil {
		s.writeMemoryError(w, r, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"version": toVersionResponse(v)})
}

// handleListMemoryRefs — GET /api/v1/libraries/{id}/memories/{memoryID}/refs
func (s *Server) handleListMemoryRefs(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, err := s.libraries.Get(actorCtx(r, u).Context(), r.PathValue("id"))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	if !s.requireCap(w, r, u, authz.EntityKey("m", lib.ID, r.PathValue("memoryID")), authz.CapRead) {
		return
	}
	store, cleanup, ok := s.openMemoryStore(w, r, lib)
	if !ok {
		return
	}
	defer cleanup()

	refs, err := store.ListRefs(r.Context(), r.PathValue("memoryID"))
	if err != nil {
		s.writeMemoryError(w, r, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"refs": toMemoryRefResponses(refs)})
}

// writeMemoryError maps memory store errors to HTTP responses.
func (s *Server) writeMemoryError(w http.ResponseWriter, r *http.Request, err error) {
	reqID := requestIDOrEmpty(r)
	var ve *memories.ValidationError
	switch {
	case errors.As(err, &ve):
		writeError(w, s.logger, reqID, http.StatusBadRequest, CodeBadRequest, ve.Error())
	case errors.Is(err, memories.ErrNotFound):
		writeError(w, s.logger, reqID, http.StatusNotFound, CodeNotFound, "Memory not found.")
	case errors.Is(err, memories.ErrVersionNotFound):
		writeError(w, s.logger, reqID, http.StatusNotFound, CodeNotFound, "Memory version not found.")
	case errors.Is(err, sql.ErrNoRows):
		writeError(w, s.logger, reqID, http.StatusNotFound, CodeNotFound, "Memory not found.")
	default:
		s.logger.Error("memory operation", "error", err)
		writeError(w, s.logger, reqID, http.StatusInternalServerError,
			CodeInternal, "Internal server error.")
	}
}
