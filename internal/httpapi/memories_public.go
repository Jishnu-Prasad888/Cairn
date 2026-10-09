package httpapi

import (
	"bytes"
	"context"
	"net/http"

	"github.com/Jishnu-Prasad888/Cairn/internal/authz"
	"github.com/Jishnu-Prasad888/Cairn/internal/memories"
)

// handlePublicShareGetMemory — GET /api/v1/shares/{token}/memory
// Returns the one memory a memory-scoped share covers, in the same shape as
// the authenticated GET .../memories/{id} — but every media URL is
// share-relative (/api/v1/shares/{token}/files/{fileID}/...) instead of
// library-relative, so an anonymous visitor's browser can actually load it.
func (s *Server) handlePublicShareGetMemory(w http.ResponseWriter, r *http.Request) {
	acc, ok := s.resolveShare(w, r)
	if !ok {
		return
	}
	memoryID, isMemory := memoryIDFromShareKey(acc.libID, acc.share.ResourceKey)
	if !isMemory {
		s.writeForbidden(w, r)
		return
	}
	if !acc.share.Capabilities.All(authz.CapRead) {
		s.writeForbidden(w, r)
		return
	}
	store, cleanup, ok := s.openMemoryStore(w, r, acc.library)
	if !ok {
		return
	}
	defer cleanup()

	doc, err := store.GetDocument(r.Context(), memoryID)
	if err != nil {
		s.writeMemoryError(w, r, err)
		return
	}
	resp, err := s.publicDocumentResponse(r.Context(), r.PathValue("token"), acc, store, doc, doc.Blocks)
	if err != nil {
		s.logger.Error("public memory document", "error", err)
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to load memory.")
		return
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"memory": resp})
}

// handlePublicShareMemoryDerived — GET /api/v1/shares/{token}/memories/images/{imageID}/derived
// Public counterpart of handleGetMemoryImageDerived: serves the edited-copy
// JPEG for one memory image, gated by the share covering that memory (an
// image belongs to exactly one memory, so the imageID alone is enough to
// find it once the share is resolved).
func (s *Server) handlePublicShareMemoryDerived(w http.ResponseWriter, r *http.Request) {
	acc, ok := s.resolveShare(w, r)
	if !ok {
		return
	}
	memoryID, isMemory := memoryIDFromShareKey(acc.libID, acc.share.ResourceKey)
	if !isMemory {
		s.writeForbidden(w, r)
		return
	}
	if !acc.share.Capabilities.All(authz.CapRead) {
		s.writeForbidden(w, r)
		return
	}
	store, cleanup, ok := s.openMemoryStore(w, r, acc.library)
	if !ok {
		return
	}
	defer cleanup()

	doc, err := store.GetDocument(r.Context(), memoryID)
	if err != nil {
		s.writeMemoryError(w, r, err)
		return
	}
	imageID := r.PathValue("imageID")
	bi, _ := findImage(doc.Blocks, imageID)
	if bi < 0 {
		s.notFound(w, r, "Memory image")
		return
	}

	f, err := store.OpenDerived(r.Context(), s.deriverFor(acc.library), memoryID, imageID)
	if err != nil {
		s.writeMemoryError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	http.ServeContent(w, r, imageID+".jpg", f.ModTime, bytes.NewReader(f.Data))
}

// publicDocumentResponse mirrors documentResponse (memories.go) for a public
// share: every referenced image is a member of the shared memory by
// construction (publicShareAllowsFile already enforces that for the
// underlying file routes), so there is no per-file authz.Can check — only
// availability. URLs point at the share's own file/derived routes rather
// than the authenticated library ones.
func (s *Server) publicDocumentResponse(
	ctx context.Context, token string, acc *shareAccess, store *memories.MemoryStore,
	m *memories.Memory, blocks []*memories.Block,
) (memoryResponse, error) {
	resp := baseMemoryResponse(m)
	ids := []string{m.CoverFileID}
	for _, b := range blocks {
		for _, img := range b.Images {
			ids = append(ids, img.SourceFileID)
		}
	}
	sources, err := store.LookupSources(ctx, ids)
	if err != nil {
		return resp, err
	}
	derived, err := store.ListDerived(ctx, m.ID)
	if err != nil {
		return resp, err
	}
	canDownload := acc.share.Capabilities.All(authz.CapDownload)
	view := func(fileID string) mediaView {
		src := sources[fileID]
		if src == nil || !src.Available() {
			status := "unknown"
			if src != nil {
				status = src.Status
			}
			return mediaView{Status: status}
		}
		v := mediaView{
			Status:    src.Status,
			Available: true,
			Name:      baseName(src.RelPath),
			MediaType: src.MediaType,
			MIMEType:  src.MIMEType,
			Width:     src.Width,
			Height:    src.Height,
		}
		base := apiBase + "/shares/" + token + "/files/" + fileID
		v.ThumbnailURL = base + "/thumbnail"
		if canDownload {
			v.OriginalURL = base + "/download"
		}
		return v
	}

	if m.CoverFileID != "" {
		v := view(m.CoverFileID)
		resp.Cover = &v
	}
	resp.Blocks = make([]blockResponse, 0, len(blocks))
	for _, b := range blocks {
		br := blockResponse{ID: b.ID, Type: string(b.Type), Position: b.Position}
		if b.Type == memories.BlockText {
			md := b.Markdown
			br.Markdown = &md
		} else {
			br.Layout = string(b.Layout)
			br.Slideshow = &slideshowJSON{Enabled: b.Slideshow, IntervalSeconds: b.SlideshowInterval}
			br.Images = make([]memoryImageResponse, 0, len(b.Images))
			for _, img := range b.Images {
				ir := memoryImageResponse{
					ID:          img.ID,
					Position:    img.Position,
					FileID:      img.SourceFileID,
					Caption:     img.Caption,
					Crop:        img.Edits.Crop,
					Rotation:    img.Edits.Rotation,
					Filter:      img.Edits.Filter,
					Adjustments: img.Edits.Adjustments,
					Edited:      !img.Edits.IsDefault(),
					Media:       view(img.SourceFileID),
				}
				if ir.Filter == "" {
					ir.Filter = memories.FilterOriginal
				}
				if d, ok := derived[img.ID]; ok && ir.Media.Available {
					ir.Derived = &derivedView{
						ID:     d.ID,
						URL:    apiBase + "/shares/" + token + "/memories/images/" + img.ID + "/derived?v=" + d.ID,
						Width:  d.Width,
						Height: d.Height,
					}
				}
				br.Images = append(br.Images, ir)
			}
		}
		resp.Blocks = append(resp.Blocks, br)
	}
	return resp, nil
}
