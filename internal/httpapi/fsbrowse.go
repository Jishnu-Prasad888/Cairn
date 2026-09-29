package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/Jishnu-Prasad888/Cairn/internal/auth"
)

// fsDir is one sub-directory offered by the folder browser.
type fsDir struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// handleBrowseDirs lists the sub-directories of a path on the server, so the
// web client can offer a folder chooser when registering a library. Admin only
// (the same caller may already register any path), directories only, and
// read-only. With no path it starts at the caller's home directory.
//
// GET /api/v1/fs/dirs?path=/mnt
func (s *Server) handleBrowseDirs(w http.ResponseWriter, r *http.Request, _ *auth.User) {
	target := strings.TrimSpace(r.URL.Query().Get("path"))
	if target == "" {
		if home, err := os.UserHomeDir(); err == nil {
			target = home
		} else {
			target = string(filepath.Separator)
		}
	}
	if !filepath.IsAbs(target) {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest, "invalid_path", "path must be absolute")
		return
	}
	target = filepath.Clean(target)

	entries, err := os.ReadDir(target)
	if err != nil {
		status := http.StatusBadRequest
		if os.IsPermission(err) {
			status = http.StatusForbidden
		}
		writeError(w, s.logger, requestIDOrEmpty(r), status, "unreadable_path", "cannot read that folder")
		return
	}

	dirs := make([]fsDir, 0, len(entries))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		full := filepath.Join(target, e.Name())
		// Follow symlinks so a linked mount point shows up as a folder.
		info, err := os.Stat(full)
		if err != nil || !info.IsDir() {
			continue
		}
		dirs = append(dirs, fsDir{Name: e.Name(), Path: full})
	}
	sort.Slice(dirs, func(i, j int) bool {
		return strings.ToLower(dirs[i].Name) < strings.ToLower(dirs[j].Name)
	})

	parent := filepath.Dir(target)
	if parent == target {
		parent = ""
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{
		"path":   target,
		"parent": parent,
		"dirs":   dirs,
	})
}
