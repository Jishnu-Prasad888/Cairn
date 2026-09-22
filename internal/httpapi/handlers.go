package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/version"
)

// healthResponse reports on the server's ability to serve requests.
type healthResponse struct {
	Status string `json:"status"`
	DB     string `json:"database"`
}

// handleHealth reports liveness and the health of core dependencies.
//
// The endpoint is deliberately cheap: it pings the database with a short
// timeout. It is suitable for container health checks and orchestration
// probes. No application state is exposed here.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	dbStatus := "ok"
	if err := s.db.PingContext(ctx); err != nil {
		s.logger.Error("health check: database ping failed", "error", err)
		dbStatus = "error"
	}

	status := "ok"
	if dbStatus != "ok" {
		status = "degraded"
	}

	writeJSON(w, s.logger, http.StatusOK, healthResponse{
		Status: status,
		DB:     dbStatus,
	})
}

// handleVersion returns build metadata about the running binary.
func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.logger, http.StatusOK, version.Get())
}
