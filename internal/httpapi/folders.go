package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"path"
	"strings"

	"github.com/Jishnu-Prasad888/Cairn/internal/auth"
	"github.com/Jishnu-Prasad888/Cairn/internal/authz"
	"github.com/Jishnu-Prasad888/Cairn/internal/media"
)

// Folder operations: what a desktop file manager offers on a folder — rename,
// move, delete (to the trash), download as a zip, and star as a favourite.

// folderPathParam reads and cleans a folder path; the root is refused.
func (s *Server) folderPathParam(w http.ResponseWriter, r *http.Request, raw string) (string, bool) {
	clean, ok := canonicalFolder(raw)
	if !ok || clean == "" {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest,
			CodeBadRequest, "Invalid folder path.")
		return "", false
	}
	return clean, true
}

// fileAllowed is a per-file permission check for operations that walk a
// folder: a deny on something inside it still holds.
func (s *Server) fileAllowed(r *http.Request, u *auth.User, libID string, c authz.Capability) func(string) bool {
	if s.authz == nil || u.Role == auth.RoleAdmin {
		return nil
	}
	return func(rel string) bool {
		ok, err := s.authz.Can(r.Context(), principalFrom(u), authz.FileKey(libID, rel), c)
		return err == nil && ok
	}
}

// handleMoveFolder — POST /api/v1/libraries/{id}/folders/move
//
// Body {path, new_path}. Renaming is a move within the same parent.
func (s *Server) handleMoveFolder(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, err := s.libraries.Get(actorCtx(r, u).Context(), r.PathValue("id"))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	var body struct {
		Path    string `json:"path"`
		NewPath string `json:"new_path"`
	}
	if err := readJSON(w, r, &body); err != nil {
		writeDomainError(w, s.logger, requestIDOrEmpty(r), err)
		return
	}
	from, ok := s.folderPathParam(w, r, body.Path)
	if !ok {
		return
	}
	to, ok := s.folderPathParam(w, r, body.NewPath)
	if !ok {
		return
	}
	if !s.requireCap(w, r, u, authz.FolderKey(lib.ID, from), authz.CapMove) {
		return
	}
	parent := path.Dir(to)
	if parent == "." {
		parent = ""
	}
	if !s.requireCap(w, r, u, folderKeyFromParent(lib.ID, parent), authz.CapCreate) {
		return
	}
	// Grants are keyed by path, so moving a folder leaves any grant inside it
	// behind. Only an admin may do that knowingly; anyone else could use it to
	// step around a deny.
	if s.authz != nil && u.Role != auth.RoleAdmin {
		grants, err := s.authz.ListGrants(r.Context(), authz.FolderKey(lib.ID, from))
		if err != nil {
			s.logger.Error("list folder grants", "error", err)
			writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
				CodeInternal, "Internal server error.")
			return
		}
		if len(grants) > 0 {
			writeError(w, s.logger, requestIDOrEmpty(r), http.StatusConflict, CodeConflict,
				"This folder has its own permissions. Ask an admin to move it.")
			return
		}
	}
	svc, cleanup, ok := s.openMediaService(w, r, lib)
	if !ok {
		return
	}
	defer cleanup()
	folder, err := svc.MoveFolder(r.Context(), from, to)
	if err != nil {
		s.writeFolderError(w, r, err)
		return
	}
	folder.LibraryID = lib.ID
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"folder": toFolderResponse(folder)})
}

// handleTrashFolder — POST /api/v1/libraries/{id}/folders/trash
//
// Body {path}. Every file in the folder goes to the trash on its own, so each
// can be restored; the emptied directories are removed.
func (s *Server) handleTrashFolder(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, err := s.libraries.Get(actorCtx(r, u).Context(), r.PathValue("id"))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	var body struct {
		Path string `json:"path"`
	}
	if err := readJSON(w, r, &body); err != nil {
		writeDomainError(w, s.logger, requestIDOrEmpty(r), err)
		return
	}
	folder, ok := s.folderPathParam(w, r, body.Path)
	if !ok {
		return
	}
	if !s.requireCap(w, r, u, authz.FolderKey(lib.ID, folder), authz.CapDelete) {
		return
	}
	svc, cleanup, ok := s.openMediaService(w, r, lib)
	if !ok {
		return
	}
	defer cleanup()
	n, err := svc.TrashFolder(r.Context(), folder, u.ID, s.fileAllowed(r, u, lib.ID, authz.CapDelete))
	if err != nil && n == 0 {
		s.writeFolderError(w, r, err)
		return
	}
	if err != nil {
		s.logger.Warn("trash folder: some files stayed", "library_id", lib.ID, "error", err)
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"trashed": n, "partial": err != nil})
}

// handleDownloadFolder — GET /api/v1/libraries/{id}/folders/download?path=
//
// Streams the folder as a zip, built on the fly (nothing is staged on disk).
func (s *Server) handleDownloadFolder(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, err := s.libraries.Get(actorCtx(r, u).Context(), r.PathValue("id"))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	folder, ok := s.folderPathParam(w, r, r.URL.Query().Get("path"))
	if !ok {
		return
	}
	if !s.requireCap(w, r, u, authz.FolderKey(lib.ID, folder), authz.CapDownload) {
		return
	}
	svc, cleanup, ok := s.openMediaService(w, r, lib)
	if !ok {
		return
	}
	defer cleanup()
	liftDeadlines(w)
	name := strings.ReplaceAll(path.Base(folder), `"`, "") + ".zip"
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`, name))
	// Once bytes are on the wire a failure can only cut the archive short.
	if err := svc.WriteFolderZip(r.Context(), folder, w,
		s.fileAllowed(r, u, lib.ID, authz.CapDownload)); err != nil {
		if errors.Is(err, media.ErrFolderNotFound) {
			w.Header().Del("Content-Disposition")
			s.writeFolderError(w, r, err)
			return
		}
		s.logger.Warn("download folder", "library_id", lib.ID, "error", err)
	}
}

// handleFavoriteFolder — PUT / DELETE /api/v1/libraries/{id}/folders/favorite?path=
func (s *Server) handleFavoriteFolder(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, err := s.libraries.Get(actorCtx(r, u).Context(), r.PathValue("id"))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	folder, ok := s.folderPathParam(w, r, r.URL.Query().Get("path"))
	if !ok {
		return
	}
	if !s.requireCap(w, r, u, authz.FolderKey(lib.ID, folder), authz.CapEdit) {
		return
	}
	store, cleanup, ok := s.openFavoriteStore(w, r, lib)
	if !ok {
		return
	}
	defer cleanup()
	if r.Method == http.MethodDelete {
		err = store.RemoveFolder(r.Context(), folder)
	} else {
		err = store.AddFolder(r.Context(), folder)
	}
	if err != nil {
		s.writeFavoriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleListFavoriteFolders — GET /api/v1/libraries/{id}/favorites/folders
//
// The starred folders that still exist, with their counts, newest star first.
func (s *Server) handleListFavoriteFolders(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, err := s.libraries.Get(actorCtx(r, u).Context(), r.PathValue("id"))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	if !s.requireCap(w, r, u, authz.LibraryKey(lib.ID), authz.CapRead) {
		return
	}
	store, cleanup, ok := s.openFavoriteStore(w, r, lib)
	if !ok {
		return
	}
	defer cleanup()
	favs, err := store.ListFolders(r.Context())
	if err != nil {
		s.writeFavoriteError(w, r, err)
		return
	}
	svc, cleanupSvc, ok := s.openMediaService(w, r, lib)
	if !ok {
		return
	}
	defer cleanupSvc()
	out := make([]folderResponse, 0, len(favs))
	for _, f := range favs {
		folder, err := svc.FolderInfo(r.Context(), f.RelPath)
		if err != nil {
			continue // moved or deleted outside Cairn: not shown
		}
		folder.LibraryID = lib.ID
		out = append(out, toFolderResponse(folder))
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"folders": out})
}

func (s *Server) writeFolderError(w http.ResponseWriter, r *http.Request, err error) {
	reqID := requestIDOrEmpty(r)
	switch {
	case errors.Is(err, media.ErrFolderNotFound):
		writeError(w, s.logger, reqID, http.StatusNotFound, CodeNotFound, "Folder not found.")
	case errors.Is(err, media.ErrAlreadyExists):
		writeError(w, s.logger, reqID, http.StatusConflict, CodeConflict,
			"A folder or file with that name already exists there.")
	case errors.Is(err, media.ErrFolderIntoItself):
		writeError(w, s.logger, reqID, http.StatusBadRequest, CodeBadRequest,
			"A folder cannot be moved inside itself.")
	default:
		s.writeMediaError(w, r, err)
	}
}
