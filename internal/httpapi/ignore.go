package httpapi

import (
	"errors"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/Jishnu-Prasad888/Cairn/internal/auth"
	"github.com/Jishnu-Prasad888/Cairn/internal/indexer"
	"github.com/Jishnu-Prasad888/Cairn/internal/library"
	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
)

// maxBrowseFiles bounds how many files one folder listing returns, so a folder
// of a hundred thousand photos does not arrive as one enormous response.
const maxBrowseFiles = 2000

// onlineLibrary looks up the library named in the path and refuses one whose
// storage is offline, since both handlers below read from it.
func (s *Server) onlineLibrary(w http.ResponseWriter, r *http.Request, u *auth.User) (*library.Library, bool) {
	lib, err := s.libraries.Get(actorCtx(r, u).Context(), r.PathValue("id"))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return nil, false
	}
	if lib.Status == library.StatusOffline {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusConflict,
			CodeConflict, "Library is offline.")
		return nil, false
	}
	return lib, true
}

// handleGetIgnoreRules lists what the scanner leaves out of a library.
// GET /api/v1/libraries/{id}/ignore
func (s *Server) handleGetIgnoreRules(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, ok := s.onlineLibrary(w, r, u)
	if !ok {
		return
	}
	db, release, err := librarydb.Acquire(filepath.Join(lib.Root, ".cairn"))
	if err != nil {
		s.logger.Error("open library db for ignore rules", "library_id", lib.ID, "error", err)
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to open library database.")
		return
	}
	defer release()
	rules, err := indexer.LoadIgnoreRules(r.Context(), db)
	if err != nil {
		s.logger.Error("load ignore rules", "library_id", lib.ID, "error", err)
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to load ignore rules.")
		return
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"rules": rules})
}

// handlePutIgnoreRules replaces what the scanner leaves out of a library. The
// next scan applies them.
// PUT /api/v1/libraries/{id}/ignore
func (s *Server) handlePutIgnoreRules(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, ok := s.onlineLibrary(w, r, u)
	if !ok {
		return
	}
	var body struct {
		Rules []indexer.IgnoreRule `json:"rules"`
	}
	if err := readJSON(w, r, &body); err != nil {
		writeDomainError(w, s.logger, requestIDOrEmpty(r), err)
		return
	}
	rules, err := indexer.NormalizeIgnoreRules(lib.Root, body.Rules)
	if err != nil {
		var ruleErr *indexer.IgnoreRuleError
		msg := "Invalid ignore rule."
		if errors.As(err, &ruleErr) {
			msg = ruleErr.Error()
		}
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest, CodeBadRequest, msg)
		return
	}
	db, release, err := librarydb.Acquire(filepath.Join(lib.Root, ".cairn"))
	if err != nil {
		s.logger.Error("open library db for ignore rules", "library_id", lib.ID, "error", err)
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to open library database.")
		return
	}
	defer release()
	if err := indexer.SaveIgnoreRules(r.Context(), db, rules); err != nil {
		s.logger.Error("save ignore rules", "library_id", lib.ID, "error", err)
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to save ignore rules.")
		return
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"rules": rules})
}

// libraryEntry is one folder or file offered by the library browser. Path is
// relative to the library root.
type libraryEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// handleBrowseLibrary lists the folders and files directly inside one folder
// of a library, so a person can point at what to ignore. Paths in and out are
// relative to the library root, and nothing outside it can be listed.
//
// GET /api/v1/libraries/{id}/fs?path=2019/raw
func (s *Server) handleBrowseLibrary(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, ok := s.onlineLibrary(w, r, u)
	if !ok {
		return
	}
	rel, ok := canonicalFolder(strings.Trim(r.URL.Query().Get("path"), "/"))
	if !ok {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest,
			"invalid_path", "path must be a folder inside the library")
		return
	}
	root := filepath.Clean(lib.Root)
	target := filepath.Join(root, filepath.FromSlash(rel))
	if !insideRoot(root, target) {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest,
			"invalid_path", "path must be a folder inside the library")
		return
	}

	entries, err := os.ReadDir(target)
	if err != nil {
		status := http.StatusBadRequest
		if os.IsPermission(err) {
			status = http.StatusForbidden
		}
		writeError(w, s.logger, requestIDOrEmpty(r), status, "unreadable_path", "cannot read that folder")
		return
	}

	dirs := []libraryEntry{}
	files := []libraryEntry{}
	truncated := false
	for _, e := range entries {
		if rel == "" && e.Name() == ".cairn" {
			continue
		}
		entry := libraryEntry{Name: e.Name(), Path: path.Join(rel, e.Name())}
		// Like the scanner, symlinks are not followed into.
		if e.IsDir() {
			dirs = append(dirs, entry)
		} else if len(files) < maxBrowseFiles {
			files = append(files, entry)
		} else {
			truncated = true
		}
	}
	byName := func(list []libraryEntry) {
		sort.Slice(list, func(i, j int) bool {
			return strings.ToLower(list[i].Name) < strings.ToLower(list[j].Name)
		})
	}
	byName(dirs)
	byName(files)

	parent := ""
	if rel != "" {
		if parent = path.Dir(rel); parent == "." {
			parent = ""
		}
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{
		"path":      rel,
		"parent":    parent,
		"dirs":      dirs,
		"files":     files,
		"truncated": truncated,
	})
}

// insideRoot reports whether target, with symlinks resolved, is root or lies
// under it, so a linked folder cannot lead the browser out of the library.
func insideRoot(root, target string) bool {
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return false
	}
	realTarget, err := filepath.EvalSymlinks(target)
	if err != nil {
		return false
	}
	return realTarget == realRoot ||
		strings.HasPrefix(realTarget, realRoot+string(filepath.Separator))
}
