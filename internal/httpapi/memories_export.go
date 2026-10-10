package httpapi

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/auth"
	"github.com/Jishnu-Prasad888/Cairn/internal/authz"
	"github.com/Jishnu-Prasad888/Cairn/internal/media"
	"github.com/Jishnu-Prasad888/Cairn/internal/memories"
)

// exportFile is one embedded image queued for a memory export archive.
type exportFile struct {
	name    string
	derived bool
	relPath string // original file, relative to the library root
	imageID string // set when the embedded bytes are a derivative of this image
}

// handleExportMemory — GET /api/v1/libraries/{id}/memories/{memoryID}/export
//
// Streams a zip archive holding the memory as portable Markdown plus every
// image it references that the caller may read. Requires read on the memory
// and on each embedded source file. Missing or unreadable images are described
// in the Markdown but not embedded.
func (s *Server) handleExportMemory(w http.ResponseWriter, r *http.Request, u *auth.User) {
	memoryID := r.PathValue("memoryID")
	mc, ok := s.openMemory(w, r, u, memoryID, authz.CapRead)
	if !ok {
		return
	}
	defer mc.cleanup()

	doc, err := mc.store.GetDocument(r.Context(), memoryID)
	if err != nil {
		s.writeMemoryError(w, r, err)
		return
	}

	// Resolve every referenced source up front so permission problems are a
	// clean error response, before the first archive byte is written.
	ids := make([]string, 0, len(doc.Blocks)+1)
	if doc.CoverFileID != "" {
		ids = append(ids, doc.CoverFileID)
	}
	for _, b := range doc.Blocks {
		for _, img := range b.Images {
			if img != nil {
				ids = append(ids, img.SourceFileID)
			}
		}
	}
	sources, err := mc.store.LookupSources(r.Context(), ids)
	if err != nil {
		s.writeMemoryError(w, r, err)
		return
	}
	derived, err := mc.store.ListDerived(r.Context(), memoryID)
	if err != nil {
		s.writeMemoryError(w, r, err)
		return
	}

	byImage := map[string]memories.ExportImage{}
	nameByKey := map[string]string{}
	var files []exportFile
	seq := 0

	// addSource embeds a library file once, reusing the same archive entry
	// when several references point at it.
	addSource := func(src *memories.Source, name func(int) string) string {
		key := "s:" + src.FileID
		if existing, ok := nameByKey[key]; ok {
			return existing
		}
		seq++
		entry := name(seq)
		nameByKey[key] = entry
		files = append(files, exportFile{name: entry, relPath: src.RelPath})
		return entry
	}

	for _, b := range doc.Blocks {
		for _, img := range b.Images {
			if img == nil {
				continue
			}
			src := sources[img.SourceFileID]
			readable := src != nil && s.can(r.Context(), u, authz.FileKey(mc.lib.ID, src.RelPath), authz.CapRead)
			ex := memories.ExportImage{}
			if readable {
				ex.SourcePath = src.RelPath
			}
			switch {
			case src == nil:
				ex.Reason = "missing"
			case !readable:
				ex.Reason = "forbidden"
			case !src.Available():
				ex.Reason = "missing"
			default:
				if d, ok := derived[img.ID]; ok && !img.Edits.IsDefault() {
					key := "d:" + d.ID
					entry, ok := nameByKey[key]
					if !ok {
						seq++
						entry = fmt.Sprintf("images/%02d.jpg", seq)
						nameByKey[key] = entry
						files = append(files, exportFile{name: entry, derived: true, imageID: img.ID})
					}
					ex.Name = entry
				} else {
					ex.Name = addSource(src, func(n int) string {
						return fmt.Sprintf("images/%02d%s", n, exportExt(src))
					})
				}
			}
			byImage[img.ID] = ex
		}
	}

	coverName := ""
	if doc.CoverFileID != "" {
		src := sources[doc.CoverFileID]
		if src != nil && src.Available() &&
			s.can(r.Context(), u, authz.FileKey(mc.lib.ID, src.RelPath), authz.CapRead) {
			coverName = addSource(src, func(n int) string {
				return fmt.Sprintf("images/cover%s", exportExt(src))
			})
		}
	}

	slug := memories.Slug(doc.Title)
	md := memories.BuildExport(doc, memories.ExportOptions{
		DocName:   slug + ".md",
		CoverName: coverName,
		Images:    byImage,
		Now:       time.Now(),
	})

	needsOriginals := false
	for _, f := range files {
		if !f.derived {
			needsOriginals = true
			break
		}
	}
	var svc *media.Service
	if needsOriginals {
		var cleanup func()
		if svc, cleanup, ok = s.openMediaService(w, r, mc.lib); !ok {
			return
		}
		defer cleanup()
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{
		"filename": slug + ".zip",
	}))
	w.WriteHeader(http.StatusOK)

	zw := zip.NewWriter(w)
	defer func() { _ = zw.Close() }()

	if err := writeZip(zw, slug+".md", bytes.NewReader([]byte(md)), time.Now(), zip.Deflate); err != nil {
		s.logger.Error("export memory: write markdown", "memory_id", memoryID, "error", err)
		return
	}
	for _, f := range files {
		if f.derived {
			df, err := mc.store.OpenDerived(r.Context(), s.deriverFor(mc.lib), memoryID, f.imageID)
			if err != nil {
				s.logger.Warn("export memory: open edited copy",
					"memory_id", memoryID, "image_id", f.imageID, "error", err)
				continue
			}
			if err := writeZip(zw, f.name, bytes.NewReader(df.Data), df.ModTime, zip.Store); err != nil {
				s.logger.Error("export memory: write edited copy", "memory_id", memoryID, "error", err)
				return
			}
			continue
		}
		fh, mf, err := svc.OpenFile(r.Context(), f.relPath)
		if err != nil {
			s.logger.Warn("export memory: open source",
				"memory_id", memoryID, "path", f.relPath, "error", err)
			continue
		}
		err = writeZip(zw, f.name, fh, mf.ModTime, zip.Store)
		_ = fh.Close()
		if err != nil {
			s.logger.Error("export memory: write source", "memory_id", memoryID, "error", err)
			return
		}
	}
}

// writeZip streams r into a single archive entry.
func writeZip(zw *zip.Writer, name string, r io.Reader, mod time.Time, method uint16) error {
	hdr := &zip.FileHeader{Name: name, Method: method, Modified: mod}
	hdr.SetMode(0o644)
	dst, err := zw.CreateHeader(hdr)
	if err != nil {
		return err
	}
	_, err = io.Copy(dst, r)
	return err
}

// exportExt picks an archive file extension for a source, preferring the
// original path's extension and falling back to its MIME type.
func exportExt(src *memories.Source) string {
	if src == nil {
		return ".bin"
	}
	if ext := path.Ext(src.RelPath); ext != "" {
		return strings.ToLower(ext)
	}
	if src.MIMEType != "" {
		if exts, err := mime.ExtensionsByType(src.MIMEType); err == nil && len(exts) > 0 {
			return exts[0]
		}
	}
	return ".bin"
}
