// Package webui serves the compiled Cairn frontend either from the embedded
// copy or, in development, from an on-disk build directory.
//
// The frontend is a React single-page application. Every non-file request is
// answered with index.html so that client-side routing keeps working after a
// direct navigation or reload.
package webui

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path"
	"strings"
	"sync"
	"time"
)

//go:embed all:dist
var embedded embed.FS

// Handler returns an http.Handler that serves the Cairn frontend as a SPA.
//
// If distDir is non-empty it is served instead of the embedded assets. This
// lets a developer run a freshly built frontend against the API server
// without recompiling the binary.
func Handler(distDir string) (http.Handler, error) {
	if distDir == "" {
		root, err := fs.Sub(embedded, "dist")
		if err != nil {
			return nil, fmt.Errorf("read embedded frontend: %w", err)
		}
		if err := requireFile(root, "index.html"); err != nil {
			return nil, fmt.Errorf("embedded frontend is incomplete: %w", err)
		}
		return &spaHandler{fsys: root, immutable: true}, nil
	}

	info, err := os.Stat(distDir)
	if err != nil {
		return nil, fmt.Errorf("CAIRN_WEB_DIST: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("CAIRN_WEB_DIST %q is not a directory", distDir)
	}
	root := os.DirFS(distDir)
	if err := requireFile(root, "index.html"); err != nil {
		return nil, fmt.Errorf("CAIRN_WEB_DIST %q is missing index.html: %w", distDir, err)
	}
	return &spaHandler{fsys: root}, nil
}

func requireFile(fsys fs.FS, name string) error {
	_, err := fs.Stat(fsys, name)
	return err
}

// spaHandler serves files from an fs.FS with single-page-app fallback.
type spaHandler struct {
	fsys fs.FS

	// immutable is set for the embedded build, whose files cannot change
	// while the process runs, so each file's gzip form and ETag are worked
	// out once and kept. An on-disk dev build is read fresh every time.
	immutable bool
	cache     sync.Map // name -> *asset
}

// asset is one prepared response body.
type asset struct {
	data []byte
	gz   []byte // nil when compression does not pay off
	etag string
}

// compressible lists the text types worth gzipping; fonts and images are
// already compressed.
var compressible = map[string]bool{
	".html": true, ".js": true, ".css": true, ".svg": true, ".json": true,
	".txt": true, ".map": true, ".webmanifest": true,
}

func prepare(name string, data []byte) *asset {
	sum := sha256.Sum256(data)
	a := &asset{data: data, etag: `"` + hex.EncodeToString(sum[:12]) + `"`}
	if compressible[path.Ext(name)] && len(data) > 1024 {
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		_, _ = zw.Write(data)
		if zw.Close() == nil && buf.Len() < len(data)*9/10 {
			a.gz = buf.Bytes()
		}
	}
	return a
}

func (h *spaHandler) load(cleaned string) (*asset, string, error) {
	if h.immutable {
		if v, ok := h.cache.Load(cleaned); ok {
			return v.(*asset), cleaned, nil
		}
	}
	data, name, err := h.readOrFallback(cleaned)
	if err != nil {
		return nil, "", err
	}
	if !h.immutable {
		return &asset{data: data}, name, nil
	}
	// Unknown paths all fall back to index.html; cache them under that name
	// so arbitrary client routes cannot grow the cache.
	if v, ok := h.cache.Load(name); ok {
		return v.(*asset), name, nil
	}
	v, _ := h.cache.LoadOrStore(name, prepare(name, data))
	return v.(*asset), name, nil
}

func (h *spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	cleaned, err := cleanPath(r.URL.Path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if cleaned == "" || cleaned == "." {
		cleaned = "index.html"
	}

	a, name, err := h.load(cleaned)
	if err != nil {
		http.Error(w, "frontend not available", http.StatusInternalServerError)
		return
	}

	if strings.HasPrefix(cleaned, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	if a.etag != "" {
		w.Header().Set("ETag", a.etag)
	}

	body := a.data
	if a.gz != nil {
		w.Header().Add("Vary", "Accept-Encoding")
		if acceptsGzip(r) && r.Header.Get("Range") == "" {
			// ServeContent would sniff the type from the compressed bytes.
			if ct := mimeType(name); ct != "" {
				w.Header().Set("Content-Type", ct)
			}
			w.Header().Set("Content-Encoding", "gzip")
			body = a.gz
		}
	}
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(body))
}

// acceptsGzip reports whether the client listed gzip in Accept-Encoding with
// a non-zero quality.
func acceptsGzip(r *http.Request) bool {
	for part := range strings.SplitSeq(r.Header.Get("Accept-Encoding"), ",") {
		coding, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if !strings.EqualFold(strings.TrimSpace(coding), "gzip") {
			continue
		}
		q := strings.ReplaceAll(strings.TrimSpace(params), " ", "")
		return q != "q=0" && q != "q=0.0" && q != "q=0.00" && q != "q=0.000"
	}
	return false
}

func mimeType(name string) string {
	switch path.Ext(name) {
	case ".html":
		return "text/html; charset=utf-8"
	case ".js":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".json", ".map":
		return "application/json"
	case ".webmanifest":
		return "application/manifest+json"
	case ".txt":
		return "text/plain; charset=utf-8"
	}
	return ""
}

// readOrFallback reads the requested file; if it does not exist it returns
// index.html so the SPA can handle client-side routes.
func (h *spaHandler) readOrFallback(cleaned string) ([]byte, string, error) {
	data, err := fs.ReadFile(h.fsys, cleaned)
	if err == nil {
		return data, cleaned, nil
	}
	index, indexErr := fs.ReadFile(h.fsys, "index.html")
	if indexErr != nil {
		return nil, "", fmt.Errorf("read %s: %v; fallback index.html: %w", cleaned, err, indexErr)
	}
	return index, "index.html", nil
}

// cleanPath converts a URL path into a safe, slash-cleaned fs.FS path.
func cleanPath(urlPath string) (string, error) {
	cleaned := path.Clean(strings.TrimPrefix(urlPath, "/"))
	if cleaned == "" || strings.HasPrefix(cleaned, "..") || path.IsAbs(cleaned) {
		return "", fs.ErrInvalid
	}
	if !fs.ValidPath(cleaned) {
		return "", fs.ErrInvalid
	}
	// Reject paths that backtrack into parent directories.
	for _, part := range strings.Split(cleaned, "/") {
		if part == ".." {
			return "", fs.ErrInvalid
		}
	}
	return cleaned, nil
}
