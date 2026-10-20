package httpapi

import (
	"bytes"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/auth"
	"github.com/Jishnu-Prasad888/Cairn/internal/authz"
	"github.com/Jishnu-Prasad888/Cairn/internal/crypto"
	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
	"github.com/Jishnu-Prasad888/Cairn/internal/media"
	"github.com/Jishnu-Prasad888/Cairn/internal/metadata"
)

// handleGetFileMetadata — GET /api/v1/libraries/{id}/files/{fileID}/metadata
// Returns extracted media metadata (dimensions, EXIF, GPS) for a file.
func (s *Server) handleGetFileMetadata(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, err := s.libraries.Get(actorCtx(r, u).Context(), r.PathValue("id"))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}

	cairnDir := filepath.Join(lib.Root, ".cairn")
	db, release, err := librarydb.Acquire(cairnDir)
	if err != nil {
		s.logger.Error("open library db", "error", err)
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to open library database.")
		return
	}
	defer release()

	store := media.NewFileStore(db, lib.ID)
	f, err := store.GetByID(r.Context(), r.PathValue("fileID"))
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	if !s.requireCap(w, r, u, authz.FileKey(lib.ID, f.RelPath), authz.CapRead) {
		return
	}

	// Return persisted metadata from media_metadata table.
	row := db.QueryRowContext(r.Context(),
		`SELECT media_type, mime_type, width, height, duration_secs, taken_at,
		        camera_make, camera_model, latitude, longitude, has_thumbnail, updated_at
		 FROM media_metadata WHERE file_id = ?`, f.ID)

	type metaResp struct {
		FileID       string   `json:"file_id"`
		MediaType    string   `json:"media_type,omitempty"`
		MIMEType     string   `json:"mime_type,omitempty"`
		Width        *int     `json:"width,omitempty"`
		Height       *int     `json:"height,omitempty"`
		DurationSecs *float64 `json:"duration_secs,omitempty"`
		TakenAt      string   `json:"taken_at,omitempty"`
		CameraMake   string   `json:"camera_make,omitempty"`
		CameraModel  string   `json:"camera_model,omitempty"`
		Latitude     *float64 `json:"latitude,omitempty"`
		Longitude    *float64 `json:"longitude,omitempty"`
		HasThumbnail bool     `json:"has_thumbnail"`
		UpdatedAt    string   `json:"updated_at,omitempty"`
	}

	var (
		resp         metaResp
		mimeType     nullableString
		width        nullableInt
		height       nullableInt
		durationSecs nullableFloat
		takenAt      nullableString
		cameraMake   nullableString
		cameraModel  nullableString
		lat          nullableFloat
		lon          nullableFloat
		hasThumbnail int
		updatedAt    string
	)
	resp.FileID = f.ID

	scanErr := row.Scan(
		&resp.MediaType, &mimeType, &width, &height, &durationSecs,
		&takenAt, &cameraMake, &cameraModel, &lat, &lon,
		&hasThumbnail, &updatedAt,
	)
	if scanErr != nil {
		// No metadata yet — return minimal response with file info.
		resp.MediaType = string(f.MediaType)
		resp.MIMEType = f.MIMEType
		resp.HasThumbnail = false
		writeJSON(w, s.logger, http.StatusOK, map[string]any{"metadata": resp})
		return
	}

	resp.MIMEType = mimeType.String
	if width.Valid {
		v := int(width.Int64)
		resp.Width = &v
	}
	if height.Valid {
		v := int(height.Int64)
		resp.Height = &v
	}
	if durationSecs.Valid {
		resp.DurationSecs = &durationSecs.Float64
	}
	resp.TakenAt = takenAt.String
	resp.CameraMake = cameraMake.String
	resp.CameraModel = cameraModel.String
	if lat.Valid {
		resp.Latitude = &lat.Float64
	}
	if lon.Valid {
		resp.Longitude = &lon.Float64
	}
	resp.HasThumbnail = hasThumbnail == 1
	resp.UpdatedAt = updatedAt

	writeJSON(w, s.logger, http.StatusOK, map[string]any{"metadata": resp})
}

// handleGetThumbnail — GET /api/v1/libraries/{id}/files/{fileID}/thumbnail
// Serves the pre-generated thumbnail, or triggers on-demand generation if
// not yet available.
func (s *Server) handleGetThumbnail(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, err := s.libraries.Get(actorCtx(r, u).Context(), r.PathValue("id"))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}

	cairnDir := filepath.Join(lib.Root, ".cairn")
	fileID := r.PathValue("fileID")

	// Resolve the file so the capability check runs on its resource key even
	// when the thumbnail already exists on disk.
	db, release, err := librarydb.Acquire(cairnDir)
	if err != nil {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to open library database.")
		return
	}
	defer release()

	store := media.NewFileStore(db, lib.ID)
	f, err := store.GetByID(r.Context(), fileID)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	if !s.requireCap(w, r, u, authz.FileKey(lib.ID, f.RelPath), authz.CapRead) {
		return
	}

	s.serveThumbnail(w, r, lib.Root, f)
}

// handleGetPreview — GET /api/v1/libraries/{id}/files/{fileID}/preview
// Serves the screen-sized rendition the viewer shows in place of a large
// original, making it on first request. 404 means the original serves as
// well (it is small already, animated, or not decodable here). It is the
// photo's content, so it needs the download capability like the original.
func (s *Server) handleGetPreview(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, err := s.libraries.Get(actorCtx(r, u).Context(), r.PathValue("id"))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}

	cairnDir := filepath.Join(lib.Root, ".cairn")
	db, release, err := librarydb.Acquire(cairnDir)
	if err != nil {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to open library database.")
		return
	}
	defer release()

	f, err := media.NewFileStore(db, lib.ID).GetByID(r.Context(), r.PathValue("fileID"))
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	if !s.requireCap(w, r, u, authz.FileKey(lib.ID, f.RelPath), authz.CapDownload) {
		return
	}
	if f.MediaType != media.MediaTypePhoto {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusNotFound,
			CodeNotFound, "Preview not available for this file.")
		return
	}

	s.serveRendition(w, r, lib.Root, f, previewRendition)
}

// rendition is a derived image of a file kept under .cairn: the grid's
// thumbnail or the viewer's preview.
type rendition struct {
	name     string
	modTime  func(cairnDir, fileID string) (time.Time, error)
	read     func(cairnDir, fileID string, keys *crypto.Keys) ([]byte, time.Time, error)
	generate func(srcPath, cairnDir, fileID string, keys *crypto.Keys) (bool, error)
}

var (
	thumbRendition = rendition{
		name: "Thumbnail", modTime: metadata.ThumbModTime,
		read: metadata.ReadThumb, generate: metadata.GenerateThumbnail,
	}
	previewRendition = rendition{
		name: "Preview", modTime: metadata.PreviewModTime,
		read: metadata.ReadPreview, generate: metadata.GeneratePreview,
	}
)

// serveThumbnail answers a thumbnail request for f in the library at root.
func (s *Server) serveThumbnail(w http.ResponseWriter, r *http.Request, root string, f *media.File) {
	s.serveRendition(w, r, root, f, thumbRendition)
}

// serveRendition answers a request for f's rendition kind in the library at
// root: the stored one when it is current, otherwise one generated now.
//
// A request carrying a version (?v=, the file's mod time and size as the
// client knows them) is cached by the browser for good: a changed file is a
// new version, so a grid scrolled back into view or revisited never asks
// again. Without a version the browser revalidates, which the If-Modified-Since
// check below answers without reading the rendition.
func (s *Server) serveRendition(w http.ResponseWriter, r *http.Request, root string, f *media.File, kind rendition) {
	cairnDir := filepath.Join(root, ".cairn")
	modTime, err := kind.modTime(cairnDir, f.ID)
	have := err == nil
	stale := have && thumbStale(modTime, f.ModTime)
	if !have || stale {
		var ok bool
		if modTime, have, stale, ok = s.makeRendition(r, root, cairnDir, f, have, kind); !ok {
			return // the client went away while waiting; nobody to answer
		}
		if !have {
			writeError(w, s.logger, requestIDOrEmpty(r), http.StatusNotFound,
				CodeNotFound, kind.name+" not available for this file.")
			return
		}
		// A stale rendition that could not be remade is served rather than none.
	}

	if r.URL.Query().Get("v") != "" && !stale {
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "private, no-cache")
	}
	if notModifiedSince(r, modTime) {
		w.Header().Set("Last-Modified", modTime.UTC().Format(http.TimeFormat))
		w.WriteHeader(http.StatusNotModified)
		return
	}
	data, modTime, err := kind.read(cairnDir, f.ID, s.keys)
	if err != nil {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to open "+strings.ToLower(kind.name)+".")
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	http.ServeContent(w, r, f.ID+".jpg", modTime, bytes.NewReader(data))
}

// makeRendition generates f's rendition kind on demand, waiting for a slot
// of s.thumbs, which is held only for the decode. It reports the rendition's
// state afterwards, and ok=false if the client gave up while waiting. had
// says whether an (outdated) one existed before.
func (s *Server) makeRendition(r *http.Request, root, cairnDir string, f *media.File, had bool, kind rendition) (
	modTime time.Time, have, stale, ok bool,
) {
	release, ok := s.thumbs.acquire(r.Context())
	if !ok {
		return time.Time{}, false, false, false
	}
	defer release()
	// While this request waited, another one (or the background worker) may
	// have made it.
	if mt, err := kind.modTime(cairnDir, f.ID); err == nil && !thumbStale(mt, f.ModTime) {
		return mt, true, false, true
	}
	absPath := filepath.Join(root, filepath.FromSlash(f.RelPath))
	if generated, err := kind.generate(absPath, cairnDir, f.ID, s.keys); err == nil && generated {
		if mt, err := kind.modTime(cairnDir, f.ID); err == nil {
			return mt, true, false, true
		}
	}
	// Nothing new: report the old one, if there was one.
	mt, err := kind.modTime(cairnDir, f.ID)
	if !had || err != nil {
		return time.Time{}, false, false, true
	}
	return mt, true, true, true
}

// thumbStale reports whether a thumbnail written at thumbMod predates the
// file content it should show: it was made from earlier content (an edit, or
// a path reused by a new file). A file dated in the future is left alone, or
// it would be regenerated on every request.
func thumbStale(thumbMod, fileMod time.Time) bool {
	return thumbMod.Before(fileMod) && !fileMod.After(time.Now())
}

// notModifiedSince reports whether r is a plain If-Modified-Since revalidation
// that modTime satisfies, so a 304 can be sent without reading (and, with
// at-rest encryption, decrypting) the body. Anything else is left to
// http.ServeContent.
func notModifiedSince(r *http.Request, modTime time.Time) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	if r.Header.Get("If-None-Match") != "" || r.Header.Get("Range") != "" {
		return false
	}
	ims := r.Header.Get("If-Modified-Since")
	if ims == "" || modTime.IsZero() {
		return false
	}
	t, err := http.ParseTime(ims)
	if err != nil {
		return false
	}
	return !modTime.Truncate(time.Second).After(t)
}

// --- nullable scan helpers ---

type nullableString struct {
	String string
	Valid  bool
}

func (n *nullableString) Scan(value any) error {
	if value == nil {
		n.Valid = false
		return nil
	}
	switch v := value.(type) {
	case string:
		n.String = v
		n.Valid = true
	case []byte:
		n.String = string(v)
		n.Valid = true
	}
	return nil
}

type nullableInt struct {
	Int64 int64
	Valid bool
}

func (n *nullableInt) Scan(value any) error {
	if value == nil {
		n.Valid = false
		return nil
	}
	switch v := value.(type) {
	case int64:
		n.Int64 = v
		n.Valid = true
	case float64:
		n.Int64 = int64(v)
		n.Valid = true
	}
	return nil
}

type nullableFloat struct {
	Float64 float64
	Valid   bool
}

func (n *nullableFloat) Scan(value any) error {
	if value == nil {
		n.Valid = false
		return nil
	}
	switch v := value.(type) {
	case float64:
		n.Float64 = v
		n.Valid = true
	case int64:
		n.Float64 = float64(v)
		n.Valid = true
	}
	return nil
}

// handlePutThumbnail — PUT /api/v1/libraries/{id}/files/{fileID}/thumbnail
// Stores a video's poster frame captured by the client, for servers without
// ffmpeg. Only videos accept one, only when no thumbnail exists yet, and only
// from someone who may edit the file: the poster is shown to every viewer.
// The body (JPEG, PNG or GIF) is decoded and re-encoded, never stored as sent.
func (s *Server) handlePutThumbnail(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, err := s.libraries.Get(actorCtx(r, u).Context(), r.PathValue("id"))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}

	cairnDir := filepath.Join(lib.Root, ".cairn")
	fileID := r.PathValue("fileID")
	db, release, err := librarydb.Acquire(cairnDir)
	if err != nil {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to open library database.")
		return
	}
	defer release()

	store := media.NewFileStore(db, lib.ID)
	f, err := store.GetByID(r.Context(), fileID)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	if !s.requireCap(w, r, u, authz.FileKey(lib.ID, f.RelPath), authz.CapRead, authz.CapEdit) {
		return
	}
	if f.MediaType != media.MediaTypeVideo {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest,
			CodeBadRequest, "Only videos accept a captured thumbnail.")
		return
	}

	stored, err := metadata.StorePoster(http.MaxBytesReader(w, r.Body, metadata.MaxPosterBytes),
		cairnDir, f.ID, s.keys)
	if err != nil {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest,
			CodeBadRequest, "The thumbnail could not be read as an image.")
		return
	}
	if stored {
		if _, err := db.ExecContext(r.Context(),
			`UPDATE media_metadata SET has_thumbnail = 1 WHERE file_id = ?`, f.ID); err != nil {
			s.logger.Warn("mark poster thumbnail", "file_id", f.ID, "error", err)
		}
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"stored": stored})
}
