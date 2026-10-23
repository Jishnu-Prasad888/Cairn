package httpapi

import (
	"errors"
	"net/http"
	"path/filepath"

	"github.com/Jishnu-Prasad888/Cairn/internal/auth"
	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
	"github.com/Jishnu-Prasad888/Cairn/internal/ml"
)

// handleGetMLRules lists the photos machine learning skips or always
// includes in a library.
// GET /api/v1/libraries/{id}/ml/rules
func (s *Server) handleGetMLRules(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, ok := s.onlineLibrary(w, r, u)
	if !ok {
		return
	}
	db, release, err := librarydb.Acquire(filepath.Join(lib.Root, ".cairn"))
	if err != nil {
		s.logger.Error("open library db for ml rules", "library_id", lib.ID, "error", err)
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to open library database.")
		return
	}
	defer release()
	rules, err := ml.LoadRules(r.Context(), db)
	if err != nil {
		s.logger.Error("load ml rules", "library_id", lib.ID, "error", err)
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to load the rules.")
		return
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"rules": rules})
}

// handlePutMLRules replaces a library's machine-learning rules and applies
// them in the background: skipped photos lose their faces and signatures,
// photos no longer skipped are analysed, and people are regrouped.
// PUT /api/v1/libraries/{id}/ml/rules
func (s *Server) handlePutMLRules(w http.ResponseWriter, r *http.Request, u *auth.User) {
	lib, ok := s.onlineLibrary(w, r, u)
	if !ok {
		return
	}
	var body struct {
		Rules []ml.Rule `json:"rules"`
	}
	if err := readJSON(w, r, &body); err != nil {
		writeDomainError(w, s.logger, requestIDOrEmpty(r), err)
		return
	}
	rules, err := ml.NormalizeRules(lib.Root, body.Rules)
	if err != nil {
		var ruleErr *ml.RuleError
		msg := "Invalid rule."
		if errors.As(err, &ruleErr) {
			msg = ruleErr.Error()
		}
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest, CodeBadRequest, msg)
		return
	}
	db, release, err := librarydb.Acquire(filepath.Join(lib.Root, ".cairn"))
	if err != nil {
		s.logger.Error("open library db for ml rules", "library_id", lib.ID, "error", err)
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to open library database.")
		return
	}
	defer release()
	if err := ml.SaveRules(r.Context(), db, rules); err != nil {
		s.logger.Error("save ml rules", "library_id", lib.ID, "error", err)
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to save the rules.")
		return
	}
	s.mlRuntime.RulesChanged(lib.ID, lib.Root)
	writeJSON(w, s.logger, http.StatusOK, map[string]any{"rules": rules})
}
