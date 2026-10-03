package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/Jishnu-Prasad888/Cairn/internal/auth"
)

type mlSettings struct {
	// Enabled is the master switch for similarity and people recognition.
	Enabled bool `json:"enabled"`
	// FaceThreshold is how alike two faces must be (cosine similarity) to be
	// grouped as one person; FaceThresholdDefault is the model's own value.
	FaceThreshold        float64 `json:"face_threshold"`
	FaceThresholdDefault float64 `json:"face_threshold_default"`
}

type mlSettingsUpdate struct {
	Enabled *bool `json:"enabled"`
	// FaceThreshold 0 restores the default.
	FaceThreshold *float64 `json:"face_threshold"`
}

func (s *Server) currentMLSettings() mlSettings {
	cur, def := s.mlRuntime.FaceThreshold()
	return mlSettings{Enabled: s.mlRuntime.Enabled(), FaceThreshold: cur, FaceThresholdDefault: def}
}

// handleGetMLSettings — GET /api/v1/ml/settings
// Anyone signed in may read the switch: the web app hides People when it is off.
func (s *Server) handleGetMLSettings(w http.ResponseWriter, _ *http.Request, _ *auth.User) {
	writeJSON(w, s.logger, http.StatusOK, s.currentMLSettings())
}

// handlePutMLSettings — PUT /api/v1/ml/settings (admin)
// Either field may be sent alone. Turning ML on starts processing every online
// library at once; new images are processed as they are indexed.
func (s *Server) handlePutMLSettings(w http.ResponseWriter, r *http.Request, _ *auth.User) {
	var in mlSettingsUpdate
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&in); err != nil ||
		(in.Enabled == nil && in.FaceThreshold == nil) {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest,
			CodeBadRequest, "Body must contain \"enabled\" and/or \"face_threshold\".")
		return
	}
	if t := in.FaceThreshold; t != nil {
		if *t < 0 || *t >= 1 {
			writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest,
				CodeBadRequest, "face_threshold must be between 0 and 1 (0 restores the default).")
			return
		}
		if err := s.mlRuntime.SetFaceThreshold(r.Context(), *t); err != nil {
			s.logger.Error("save face threshold", "error", err)
			writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
				CodeInternal, "Could not save the setting.")
			return
		}
	}
	if in.Enabled != nil {
		if err := s.mlRuntime.Set(r.Context(), *in.Enabled); err != nil {
			s.logger.Error("save ml setting", "error", err)
			writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
				CodeInternal, "Could not save the setting.")
			return
		}
	}
	writeJSON(w, s.logger, http.StatusOK, s.currentMLSettings())
}
