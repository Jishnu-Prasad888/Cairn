package httpapi

import (
	"bytes"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/authz"
	"github.com/Jishnu-Prasad888/Cairn/internal/library"
	"github.com/Jishnu-Prasad888/Cairn/internal/media"
	"github.com/Jishnu-Prasad888/Cairn/internal/metadata"
)

// sharePasswordHeader carries an optional share password on public requests.
const sharePasswordHeader = "X-Cairn-Share-Password"

// shareAuthenticatedFunc is a handler that has already been granted access to
// a share.
type shareAccess struct {
	share   *authz.Share
	library *library.Library
	libID   string
}

// resolveShare authenticates the share token (and optional password) and
// resolves the owning library. Denied or malformed shares receive
// UNAUTHORIZED without revealing which check failed.
//
// The password travels as a header on every JSON request, but an `<img>` or
// `<video>` tag cannot set one — the browser issues a plain GET. Those
// requests carry the password as a query parameter instead; a header always
// wins if both are present.
func (s *Server) resolveShare(w http.ResponseWriter, r *http.Request) (*shareAccess, bool) {
	password := r.Header.Get(sharePasswordHeader)
	if password == "" {
		password = r.URL.Query().Get("password")
	}
	sh, err := s.authz.AuthenticateShare(r.Context(), r.PathValue("token"), password)
	if err != nil {
		s.writeAuthzError(w, r, err)
		return nil, false
	}
	libID := shareLibraryID(sh.ResourceKey)
	lib, err := s.libraries.Get(r.Context(), libID)
	if err != nil {
		s.logger.Error("share library lookup", "library_id", libID, "error", err)
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusNotFound, CodeNotFound,
			"Share not found.")
		return nil, false
	}
	return &shareAccess{share: sh, library: lib, libID: libID}, true
}

// shareCan verifies the share grants all given capabilities on the resource
// key. Share capabilities flow through the same grant evaluation as user
// permissions: a share never bypasses authorization, it only adds a grant
// rooted at its resource key, inherited by descendants.
func (a *shareAccess) shareCan(key string, caps ...authz.Capability) bool {
	return a.share.Capabilities.All(caps...) && coversKey(a.share.ResourceKey, key)
}

// shareLibraryID extracts the library id from a resource key prefix.
func shareLibraryID(key string) string {
	if i := strings.Index(key, "/"); i > 0 {
		return key[:i]
	}
	return key
}

// coversKey reports whether ancestor shares or equals key at a "/" boundary.
func coversKey(ancestor, key string) bool {
	if ancestor == key {
		return true
	}
	return strings.HasPrefix(key, ancestor+"/")
}

// albumIDFromShareKey reports the album id when key is exactly an album
// entity key (authz.EntityKey("a", libID, id)) — never a deeper key that
// merely contains the album marker, since an album has no descendants.
// An album's files can live anywhere in the library and belong to several
// albums at once, so they are not reachable through the folder/file key
// hierarchy `coversKey` walks for every other share scope; a public share
// rooted at an album needs this instead, to resolve to the album's own
// membership rather than a subtree that does not exist.
func albumIDFromShareKey(libID, key string) (string, bool) {
	prefix := libID + "/a:"
	if !strings.HasPrefix(key, prefix) {
		return "", false
	}
	id := key[len(prefix):]
	if id == "" || strings.Contains(id, "/") {
		return "", false
	}
	return id, true
}

// publicShareAllowsFile reports whether a public share permits an action on
// one file. For an album-scoped share this is album membership rather than
// the key-covers check every other scope uses (see albumIDFromShareKey). On
// an internal error it writes the response itself, signalled by `responded`.
func (s *Server) publicShareAllowsFile(
	w http.ResponseWriter, r *http.Request, acc *shareAccess, f *media.File, caps ...authz.Capability,
) (allowed, responded bool) {
	albumID, isAlbum := albumIDFromShareKey(acc.libID, acc.share.ResourceKey)
	if !isAlbum {
		return acc.shareCan(authz.FileKey(acc.libID, f.RelPath), caps...), false
	}
	if !acc.share.Capabilities.All(caps...) {
		return false, false
	}
	store, cleanup, ok := s.openAlbumStore(w, r, acc.library)
	if !ok {
		return false, true
	}
	defer cleanup()
	files, err := store.ListFiles(r.Context(), albumID)
	if err != nil {
		s.logger.Error("public share album membership", "error", err)
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to check album membership.")
		return false, true
	}
	for _, af := range files {
		if af.ID == f.ID {
			return true, false
		}
	}
	return false, false
}

// handlePublicShareInfo — GET /api/v1/shares/{token}
// Public share metadata (no capability data leaks; only existence + scope).
func (s *Server) handlePublicShareInfo(w http.ResponseWriter, r *http.Request) {
	acc, ok := s.resolveShare(w, r)
	if !ok {
		return
	}
	// Even without read on the scope, the share info shows what the share
	// covers and the owning library name.
	writeJSON(w, s.logger, http.StatusOK, map[string]any{
		"share": map[string]any{
			"resource_key": acc.share.ResourceKey,
			"library":      acc.library.Name,
			"has_password": acc.share.PasswordHash.Valid,
			"expires_at":   shareExpiresString(acc.share),
		},
	})
}

func shareExpiresString(sh *authz.Share) any {
	if sh.ExpiresAt == nil {
		return nil
	}
	return sh.ExpiresAt.UTC().Format(time.RFC3339Nano)
}

// handlePublicShareListFiles — GET /api/v1/shares/{token}/files
func (s *Server) handlePublicShareListFiles(w http.ResponseWriter, r *http.Request) {
	acc, ok := s.resolveShare(w, r)
	if !ok {
		return
	}

	if albumID, isAlbum := albumIDFromShareKey(acc.libID, acc.share.ResourceKey); isAlbum {
		if !acc.share.Capabilities.All(authz.CapRead) {
			s.writeForbidden(w, r)
			return
		}
		store, cleanup, ok := s.openAlbumStore(w, r, acc.library)
		if !ok {
			return
		}
		defer cleanup()
		files, err := store.ListFiles(r.Context(), albumID)
		if err != nil {
			s.logger.Error("public share list album files", "error", err)
			writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
				CodeInternal, "Failed to list album files.")
			return
		}
		writeJSON(w, s.logger, http.StatusOK, map[string]any{
			"files": toFileResponses(files),
			"total": len(files),
		})
		return
	}

	svc, cleanup, ok := s.openMediaService(w, r, acc.library)
	if !ok {
		return
	}
	defer cleanup()

	folder := r.URL.Query().Get("folder")
	if !acc.shareCan(folderKeyFromParent(acc.libID, folder), authz.CapRead) {
		s.writeForbidden(w, r)
		return
	}

	opts := parseListOptions(r)
	opts.FolderPath = folder
	page, err := svc.Store().List(r.Context(), opts)
	if err != nil {
		s.logger.Error("share list files", "error", err)
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to list files.")
		return
	}
	// Filter out files that fall outside the share's granted scope.
	files := make([]*media.File, 0, len(page.Files))
	for _, f := range page.Files {
		if acc.shareCan(authz.FileKey(acc.libID, f.RelPath), authz.CapRead) {
			files = append(files, f)
		}
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{
		"files":       toFileResponses(files),
		"next_cursor": page.NextCursor,
		"total":       page.Total,
	})
}

// handlePublicShareGetFile — GET /api/v1/shares/{token}/files/{fileID}
func (s *Server) handlePublicShareGetFile(w http.ResponseWriter, r *http.Request) {
	acc, ok := s.resolveShare(w, r)
	if !ok {
		return
	}
	svc, cleanup, ok := s.openMediaService(w, r, acc.library)
	if !ok {
		return
	}
	defer cleanup()

	f, err := svc.Store().GetByID(r.Context(), r.PathValue("fileID"))
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	allowed, responded := s.publicShareAllowsFile(w, r, acc, f, authz.CapRead)
	if responded {
		return
	}
	if !allowed {
		s.writeForbidden(w, r)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"file": toFileResponse(f)})
}

// handlePublicShareThumbnail — GET /api/v1/shares/{token}/files/{fileID}/thumbnail
// So a public share can render a photo grid rather than a bare file list —
// the same small JPEG preview the authenticated grid uses, generated on
// demand the first time and cached on disk after that.
func (s *Server) handlePublicShareThumbnail(w http.ResponseWriter, r *http.Request) {
	acc, ok := s.resolveShare(w, r)
	if !ok {
		return
	}
	svc, cleanup, ok := s.openMediaService(w, r, acc.library)
	if !ok {
		return
	}
	defer cleanup()

	f, err := svc.Store().GetByID(r.Context(), r.PathValue("fileID"))
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	allowed, responded := s.publicShareAllowsFile(w, r, acc, f, authz.CapRead)
	if responded {
		return
	}
	if !allowed {
		s.writeForbidden(w, r)
		return
	}

	cairnDir := filepath.Join(acc.library.Root, ".cairn")
	data, modTime, err := metadata.ReadThumb(cairnDir, f.ID, s.keys)
	if err == nil {
		w.Header().Set("Content-Type", "image/jpeg")
		http.ServeContent(w, r, f.ID+".jpg", modTime, bytes.NewReader(data))
		return
	}

	absPath := filepath.Join(acc.library.Root, filepath.FromSlash(f.RelPath))
	generated, err := metadata.GenerateThumbnail(absPath, cairnDir, f.ID, s.keys)
	if err != nil || !generated {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusNotFound,
			CodeNotFound, "Thumbnail not available for this file.")
		return
	}
	data, modTime, err = metadata.ReadThumb(cairnDir, f.ID, s.keys)
	if err != nil {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to open generated thumbnail.")
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	http.ServeContent(w, r, f.ID+".jpg", modTime, bytes.NewReader(data))
}

// handlePublicShareDownload — GET /api/v1/shares/{token}/files/{fileID}/download
func (s *Server) handlePublicShareDownload(w http.ResponseWriter, r *http.Request) {
	acc, ok := s.resolveShare(w, r)
	if !ok {
		return
	}
	svc, cleanup, ok := s.openMediaService(w, r, acc.library)
	if !ok {
		return
	}
	defer cleanup()

	f, err := svc.Store().GetByID(r.Context(), r.PathValue("fileID"))
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	allowed, responded := s.publicShareAllowsFile(w, r, acc, f, authz.CapRead, authz.CapDownload)
	if responded {
		return
	}
	if !allowed {
		s.writeForbidden(w, r)
		return
	}

	fh, _, err := svc.OpenFile(r.Context(), f.RelPath)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	defer func() { _ = fh.Close() }()

	w.Header().Set("Content-Type", f.MIMEType)
	w.Header().Set("Content-Disposition",
		`attachment; filename="`+f.Name+`"`)
	http.ServeContent(w, r, f.Name, f.ModTime, fh)
}

// handlePublicShareAuthenticate — POST /api/v1/shares/{token}/authenticate
// Validates the share token (and password, when set) and returns whether
// access is granted. Public share clients send the password header on
// subsequent requests; this endpoint exists so the web UI can confirm a
// password before navigating.
func (s *Server) handlePublicShareAuthenticate(w http.ResponseWriter, r *http.Request) {
	if !s.limitPublicAuth(w, r, "") {
		return
	}
	if _, ok := s.resolveShare(w, r); !ok {
		return
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"authenticated": true})
}
