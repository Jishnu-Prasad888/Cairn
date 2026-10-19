package httpapi

import (
	"compress/gzip"
	"net/http"
	"strings"
	"sync"
)

// gzipJSON compresses JSON responses for clients that accept gzip. File
// listings run to hundreds of kilobytes and shrink several-fold, which is
// most of their load time over Wi-Fi or a remote link.
//
// Only a response that declares application/json when its header is written
// is compressed. Downloads, thumbnails, Range responses and anything already
// encoded pass through untouched, so they keep their Content-Length and seek
// support.
func gzipJSON(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead || !acceptsGzip(r) {
			next.ServeHTTP(w, r)
			return
		}
		gw := &gzipJSONWriter{ResponseWriter: w}
		defer gw.finish()
		next.ServeHTTP(gw, r)
	})
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

// gzipWriters recycles compressors; each holds sizeable window buffers.
var gzipWriters = sync.Pool{New: func() any {
	zw, _ := gzip.NewWriterLevel(nil, gzip.BestSpeed)
	return zw
}}

type gzipJSONWriter struct {
	http.ResponseWriter
	zw          *gzip.Writer
	wroteHeader bool
}

func (g *gzipJSONWriter) WriteHeader(status int) {
	if g.wroteHeader {
		return
	}
	g.wroteHeader = true
	h := g.Header()
	if status >= 200 && status != http.StatusNoContent && status != http.StatusNotModified &&
		h.Get("Content-Encoding") == "" &&
		strings.HasPrefix(h.Get("Content-Type"), "application/json") {
		h.Add("Vary", "Accept-Encoding")
		h.Set("Content-Encoding", "gzip")
		h.Del("Content-Length")
		g.zw = gzipWriters.Get().(*gzip.Writer)
		g.zw.Reset(g.ResponseWriter)
	}
	g.ResponseWriter.WriteHeader(status)
}

func (g *gzipJSONWriter) Write(b []byte) (int, error) {
	if !g.wroteHeader {
		if g.Header().Get("Content-Type") == "" {
			// Match net/http, which would sniff the type from these bytes.
			g.Header().Set("Content-Type", http.DetectContentType(b))
		}
		g.WriteHeader(http.StatusOK)
	}
	if g.zw != nil {
		return g.zw.Write(b)
	}
	return g.ResponseWriter.Write(b)
}

// Flush pushes buffered compressed bytes to the client.
func (g *gzipJSONWriter) Flush() {
	if g.zw != nil {
		_ = g.zw.Flush()
	}
	if f, ok := g.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (g *gzipJSONWriter) Unwrap() http.ResponseWriter { return g.ResponseWriter }

func (g *gzipJSONWriter) finish() {
	if g.zw == nil {
		return
	}
	_ = g.zw.Close()
	g.zw.Reset(nil)
	gzipWriters.Put(g.zw)
	g.zw = nil
}
