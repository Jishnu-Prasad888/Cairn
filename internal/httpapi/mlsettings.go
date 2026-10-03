package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/Jishnu-Prasad888/Cairn/internal/auth"
)

type mlSettings struct {
	// Enabled is the master switch for similarity and people recognition.
	Enabled bool `json:"enabled"`
}

// handleGetMLSettings — GET /api/v1/ml/settings
// Anyone signed in may read the switch: the web app hides People when it is off.
func (s *Server) handleGetMLSettings(w http.ResponseWriter, _ *http.Request, _ *auth.User) {
	writeJSON(w, s.logger, http.StatusOK, mlSettings{Enabled: s.mlRuntime.Enabled()})
}

// handlePutMLSettings — PUT /api/v1/ml/settings (admin)
// Turning ML on starts processing every online library at once; new images are
// processed as they are indexed.
func (s *Server) handlePutMLSettings(w http.ResponseWriter, r *http.Request, _ *auth.User) {
	var in mlSettings
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&in); err != nil {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest,
			CodeBadRequest, "Body must be {\"enabled\": true|false}.")
		return
	}
	if err := s.mlRuntime.Set(r.Context(), in.Enabled); err != nil {
		s.logger.Error("save ml setting", "error", err)
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Could not save the setting.")
		return
	}
	writeJSON(w, s.logger, http.StatusOK, mlSettings{Enabled: s.mlRuntime.Enabled()})
}
