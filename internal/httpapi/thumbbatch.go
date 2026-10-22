package httpapi

import (
	"bytes"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/auth"
	"github.com/Jishnu-Prasad888/Cairn/internal/authz"
	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
	"github.com/Jishnu-Prasad888/Cairn/internal/media"
	"github.com/Jishnu-Prasad888/Cairn/internal/metadata"
)

// MaxThumbBatch is the most thumbnails one batch request may ask for. A
// screenful of tiles in a few requests, and a response small enough (a few
// hundred kilobytes) that a cancelled one wastes little.
const MaxThumbBatch = 64

// thumbBatchMagic opens every batch response, ahead of the manifest length.
const thumbBatchMagic = "CTB1"

var smallThumbRendition = rendition{
	name: "Thumbnail", modTime: metadata.SmallThumbModTime,
	read: metadata.ReadSmallThumb, generate: metadata.GenerateSmallThumbnail,
}

// thumbBatchItem is one entry of a batch response's manifest. Size is the
// number of JPEG bytes this item contributes to the body, in manifest order.
// Missing means there is no stored thumbnail to send: the client asks for that
// one on its own, which makes it (the batch never decodes an original).
type thumbBatchItem struct {
	ID      string `json:"id"`
	Size    int    `json:"size,omitempty"`
	Missing bool   `json:"missing,omitempty"`
}

// handleThumbnailBatch — GET /api/v1/libraries/{id}/thumbnails?ids=a,b,c&size=sm|md
//
// Many stored thumbnails in one response, so a grid of tiny tiles is filled by
// a handful of requests rather than one per tile — which matters most over
// HTTP/1.1, where a browser holds only about six connections to the server.
//
// The body is binary: the 4 bytes "CTB1", a big-endian uint32 manifest
// length, the manifest (JSON: {"items":[{"id","size"}|{"id","missing"}]}),
// then each item's JPEG bytes back to back in manifest order. size=sm (the
// default) is the 256px small thumbnail, made here from the stored full
// thumbnail when it is not there yet; size=md is the 400px full thumbnail.
// Files the caller may not read are reported missing, like files that are not
// there, so the response says nothing about them.
func (s *Server) handleThumbnailBatch(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, err := s.libraries.Get(actorCtx(r, u).Context(), r.PathValue("id"))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	query := r.URL.Query()
	ids := splitIDs(query.Get("ids"))
	if len(ids) == 0 || len(ids) > MaxThumbBatch {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest,
			CodeBadRequest, "ids must list between 1 and 64 file ids.")
		return
	}
	small := true
	switch query.Get("size") {
	case "", "sm":
	case "md":
		small = false
	default:
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest,
			CodeBadRequest, "size must be sm or md.")
		return
	}

	cairnDir := lib.Root + "/.cairn"
	db, release, err := librarydb.Acquire(cairnDir)
	if err != nil {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to open library database.")
		return
	}
	defer release()

	files, err := media.NewFileStore(db, lib.ID).GetByIDs(r.Context(), ids)
	if err != nil {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to look up files.")
		return
	}
	byID := make(map[string]*media.File, len(files))
	for _, f := range files {
		byID[f.ID] = f
	}

	items := make([]thumbBatchItem, 0, len(ids))
	var body bytes.Buffer
	for _, id := range ids {
		if r.Context().Err() != nil {
			return // the grid scrolled on and cancelled; nobody is listening
		}
		f := byID[id]
		var data []byte
		if f != nil && s.mayRead(r, u, authz.FileKey(lib.ID, f.RelPath)) {
			data = s.storedThumb(r, db, cairnDir, f, small)
		}
		if data == nil {
			items = append(items, thumbBatchItem{ID: id, Missing: true})
			continue
		}
		items = append(items, thumbBatchItem{ID: id, Size: len(data)})
		body.Write(data)
	}

	manifest, err := json.Marshal(map[string]any{"items": items})
	if err != nil {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to encode thumbnails.")
		return
	}
	var head [8]byte
	copy(head[:4], thumbBatchMagic)
	binary.BigEndian.PutUint32(head[4:], uint32(len(manifest)))

	// The client keeps what it receives in its own store, keyed by each
	// file's version; a batch (an arbitrary set of ids) is never asked again.
	w.Header().Set("Content-Type", "application/vnd.cairn.thumbnails")
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(head[:])
	_, _ = w.Write(manifest)
	_, _ = w.Write(body.Bytes())
}

// storedThumb returns f's thumbnail bytes when they can be had without
// decoding the original, or nil. A missing small thumbnail is derived from a
// current full one (a 400px decode), and its colour recorded on the way.
func (s *Server) storedThumb(r *http.Request, db *sql.DB, cairnDir string, f *media.File, small bool) []byte {
	if f.MediaType != media.MediaTypePhoto && f.MediaType != media.MediaTypeVideo {
		return nil
	}
	fresh := func(modTime func(string, string) (time.Time, error)) bool {
		mt, err := modTime(cairnDir, f.ID)
		return err == nil && !thumbStale(mt, f.ModTime)
	}
	if !small {
		if !fresh(metadata.ThumbModTime) {
			return nil
		}
		data, _, err := metadata.ReadThumb(cairnDir, f.ID, s.keys)
		if err != nil {
			return nil
		}
		return data
	}
	if !fresh(metadata.SmallThumbModTime) {
		if !fresh(metadata.ThumbModTime) {
			return nil
		}
		color, err := metadata.MakeSmallThumb(cairnDir, f.ID, s.keys)
		if err != nil {
			s.logger.Warn("make small thumbnail", "file_id", f.ID, "error", err)
			return nil
		}
		if err := metadata.StoreColor(r.Context(), db, f.ID, color); err != nil {
			s.logger.Warn("store placeholder colour", "file_id", f.ID, "error", err)
		}
	}
	data, _, err := metadata.ReadSmallThumb(cairnDir, f.ID, s.keys)
	if err != nil {
		return nil
	}
	return data
}

// mayRead reports whether u can read key, without writing a response: a
// batch leaves out what it may not show rather than failing as a whole.
func (s *Server) mayRead(r *http.Request, u *auth.User, key string) bool {
	if s.authz == nil {
		return u.Role == auth.RoleAdmin
	}
	ok, err := s.authz.Can(r.Context(), principalFrom(u), key, authz.CapRead)
	if err != nil {
		s.logger.Error("authorization check", "key", key, "error", err)
		return false
	}
	return ok
}

// splitIDs parses a comma-separated id list, dropping empties and repeats.
func splitIDs(raw string) []string {
	if raw == "" {
		return nil
	}
	seen := make(map[string]bool)
	var out []string
	for _, id := range strings.Split(raw, ",") {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}
