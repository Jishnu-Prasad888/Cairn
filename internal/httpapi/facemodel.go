package httpapi

import (
	"net/http"

	"github.com/Jishnu-Prasad888/Cairn/internal/auth"
)

// handleGetFaceModel — GET /api/v1/ml/model (admin)
// Whether the face-recognition model is installed, and the progress of a
// download in flight.
func (s *Server) handleGetFaceModel(w http.ResponseWriter, _ *http.Request, _ *auth.User) {
	writeJSON(w, s.logger, http.StatusOK, s.faceModel.Status())
}

// handleDownloadFaceModel — POST /api/v1/ml/model/download (admin)
// Starts the download in the background and returns at once; poll the GET
// route for progress. The download carries on if the browser goes away.
func (s *Server) handleDownloadFaceModel(w http.ResponseWriter, _ *http.Request, _ *auth.User) {
	writeJSON(w, s.logger, http.StatusAccepted, s.faceModel.Start())
}
