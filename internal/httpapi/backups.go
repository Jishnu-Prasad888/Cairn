package httpapi

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/auth"
	"github.com/Jishnu-Prasad888/Cairn/internal/backups"
)

// backupResponse is the API representation of a backup record.
type backupResponse struct {
	ID            string `json:"id"`
	Status        string `json:"status"`
	Destination   string `json:"destination"`
	StartedAt     string `json:"started_at"`
	FinishedAt    string `json:"finished_at,omitempty"`
	Libraries     int    `json:"libraries"`
	Files         int    `json:"files"`
	FilesSkipped  int    `json:"files_skipped"`
	Bytes         int64  `json:"bytes"`
	StoredBytes   int64  `json:"stored_bytes"`
	Encrypted     bool   `json:"encrypted"`
	SameDevice    bool   `json:"same_device"`
	VerifyStatus  string `json:"verify_status,omitempty"`
	VerifyChecked int    `json:"verify_checked"`
	VerifyErrors  int    `json:"verify_errors"`
	ErrorMsg      string `json:"error_msg,omitempty"`
	CreatedAt     string `json:"created_at"`
	// Remote is set for backups on an SFTP/FTP/SMB destination.
	Remote bool `json:"remote"`
	// Reason is why the backup ran: manual, schedule or size.
	Reason string `json:"reason"`
}

func toBackupResponse(r *backups.Record) backupResponse {
	return backupResponse{
		ID:            r.ID,
		Status:        string(r.Status),
		Destination:   r.Destination,
		StartedAt:     r.StartedAt.UTC().Format(time.RFC3339),
		FinishedAt:    formatOptionalTime(r.FinishedAt),
		Libraries:     r.Libraries,
		Files:         r.Files,
		FilesSkipped:  r.FilesSkipped,
		Bytes:         r.Bytes,
		StoredBytes:   r.StoredBytes,
		Encrypted:     r.Encrypted,
		SameDevice:    r.SameDevice,
		VerifyStatus:  r.VerifyStatus,
		VerifyChecked: r.VerifyChecked,
		VerifyErrors:  r.VerifyErrors,
		ErrorMsg:      r.ErrorMsg,
		CreatedAt:     r.CreatedAt.UTC().Format(time.RFC3339),
		Remote:        r.Target != "",
		Reason:        r.Reason,
	}
}

func toBackupResponses(recs []backups.Record) []backupResponse {
	out := make([]backupResponse, 0, len(recs))
	for _, r := range recs {
		out = append(out, toBackupResponse(&r))
	}
	return out
}

func formatOptionalTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// handleRunBackup — POST /api/v1/backups
// Runs a backup now (if one is not already in progress) and returns the
// resulting record. The run is synchronous so the client can poll the record.
//
// With {"background": true} the run continues after the response, which is
// 202 with the running record; poll GET /backups/{id} or /backups/status.
// Long runs to remote destinations should use it, since a synchronous run
// can outlast the server's write timeout.
func (s *Server) handleRunBackup(w http.ResponseWriter, r *http.Request, u *auth.User) {
	var in struct {
		Background bool `json:"background"`
	}
	if r.ContentLength != 0 {
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&in)
	}
	if in.Background {
		rec, err := s.backups.RunInBackground(r.Context())
		if err != nil {
			writeError(w, s.logger, requestIDOrEmpty(r), http.StatusConflict, CodeConflict,
				"Backup could not be started: "+err.Error())
			return
		}
		writeJSON(w, s.logger, http.StatusAccepted, toBackupResponse(rec))
		return
	}
	rec, err := s.backups.Run(r.Context())
	if err != nil {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusConflict, CodeConflict,
			"Backup could not be started: "+err.Error())
		return
	}
	writeJSON(w, s.logger, http.StatusOK, toBackupResponse(rec))
}

// handleListBackups — GET /api/v1/backups
func (s *Server) handleListBackups(w http.ResponseWriter, r *http.Request, u *auth.User) {
	recs, err := s.backups.List(r.Context(), 50)
	if err != nil {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusInternalServerError,
			CodeInternal, "Failed to list backups.")
		return
	}
	writeJSON(w, s.logger, http.StatusOK, toBackupResponses(recs))
}

// handleGetBackup — GET /api/v1/backups/{id}
func (s *Server) handleGetBackup(w http.ResponseWriter, r *http.Request, u *auth.User) {
	rec, err := s.backups.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusNotFound, CodeNotFound,
			"No such backup.")
		return
	}
	writeJSON(w, s.logger, http.StatusOK, toBackupResponse(&rec))
}

// handleVerifyBackup — POST /api/v1/backups/{id}/verify
// Re-runs sample verification over an existing completed backup.
func (s *Server) handleVerifyBackup(w http.ResponseWriter, r *http.Request, u *auth.User) {
	rec, err := s.backups.Verify(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest, CodeBadRequest,
			"Verification failed: "+err.Error())
		return
	}
	writeJSON(w, s.logger, http.StatusOK, toBackupResponse(rec))
}

// handleRestoreBackup — POST /api/v1/backups/{id}/restore
// Restores a completed backup's contents into the given destination directory.
type restoreBackupRequest struct {
	Destination string `json:"destination"`
}

func (s *Server) handleRestoreBackup(w http.ResponseWriter, r *http.Request, u *auth.User) {
	var req restoreBackupRequest
	if err := readJSON(w, r, &req); err != nil {
		writeDomainError(w, s.logger, requestIDOrEmpty(r), err)
		return
	}
	if req.Destination == "" {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest, CodeBadRequest,
			"Restore destination is required.")
		return
	}
	rec, err := s.backups.Restore(r.Context(), r.PathValue("id"), req.Destination)
	if err != nil {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest, CodeBadRequest,
			"Restore failed: "+err.Error())
		return
	}
	writeJSON(w, s.logger, http.StatusOK, toBackupResponse(rec))
}

// backupDestination is the API form of a destination: secrets are never
// returned, only whether one is stored.
type backupDestination struct {
	backups.Destination
	PasswordSet   bool `json:"password_set"`
	PrivateKeySet bool `json:"private_key_set"`
	// Location is the human-readable destination ("/mnt/usb/cairn",
	// "sftp://me@nas:22/backups").
	Location string `json:"location"`
}

func toBackupDestination(d backups.Destination) backupDestination {
	loc := ""
	if d.Configured() {
		loc = d.Key()
	}
	return backupDestination{Destination: d, PasswordSet: d.Password != "",
		PrivateKeySet: d.PrivateKey != "", Location: loc}
}

// backupSettings is the administrator-editable backup policy.
type backupSettings struct {
	// Dir is the local backup directory; empty when backups are disabled or
	// go to a remote destination. Kept for older clients.
	Dir       string `json:"dir"`
	Keep      int    `json:"keep"`
	Encrypted bool   `json:"encrypted"`
	// IntervalMinutes mirrors an interval schedule (0 otherwise). Kept for
	// older clients; Schedule is authoritative.
	IntervalMinutes int               `json:"interval_minutes"`
	Destination     backupDestination `json:"destination"`
	Schedule        backups.Schedule  `json:"schedule"`
	Triggers        backups.Triggers  `json:"triggers"`
}

func (s *Server) currentBackupSettings() backupSettings {
	c := s.backups.BackupConfig()
	sched := s.backups.Schedule()
	interval := 0
	if sched.Mode == backups.ScheduleInterval {
		interval = sched.IntervalMinutes
	}
	return backupSettings{Dir: c.Dir, Keep: c.Keep, Encrypted: c.Passphrase != "",
		IntervalMinutes: interval,
		Destination:     toBackupDestination(s.backups.Destination()),
		Schedule:        sched,
		Triggers:        s.backups.Triggers()}
}

// handleGetBackupSettings — GET /api/v1/backups/settings
func (s *Server) handleGetBackupSettings(w http.ResponseWriter, _ *http.Request, _ *auth.User) {
	writeJSON(w, s.logger, http.StatusOK, s.currentBackupSettings())
}

// destinationInput is a destination edit. Password and private_key are
// optional: left out, a stored secret for the same server and login is kept;
// an empty string clears it.
type destinationInput struct {
	backups.Destination
	Password   *string `json:"password"`
	PrivateKey *string `json:"private_key"`
	// ForgetHostKey re-pins an SFTP server's key on save.
	ForgetHostKey bool `json:"forget_host_key"`
}

func (in destinationInput) update() backups.DestinationUpdate {
	return backups.DestinationUpdate{Destination: in.Destination, Password: in.Password,
		PrivateKey: in.PrivateKey, ForgetHostKey: in.ForgetHostKey}
}

// handlePutBackupSettings — PUT /api/v1/backups/settings
//
// Accepts any of "dir" (a local directory; the original form), "destination",
// "schedule" and "triggers". Each part present is validated and applied; a
// destination is tested (created, or connected to and written) before it is
// saved.
func (s *Server) handlePutBackupSettings(w http.ResponseWriter, r *http.Request, _ *auth.User) {
	var in struct {
		Dir         *string           `json:"dir"`
		Destination *destinationInput `json:"destination"`
		Schedule    *backups.Schedule `json:"schedule"`
		Triggers    *backups.Triggers `json:"triggers"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in); err != nil ||
		(in.Dir == nil && in.Destination == nil && in.Schedule == nil && in.Triggers == nil) {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest,
			CodeBadRequest, "Body must contain \"dir\", \"destination\", \"schedule\" or \"triggers\".")
		return
	}
	bad := func(prefix string, err error) {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest, CodeBadRequest, prefix+err.Error())
	}
	if in.Dir != nil {
		if err := s.backups.SetDir(r.Context(), *in.Dir); err != nil {
			bad("Could not use that backup directory: ", err)
			return
		}
	}
	if in.Destination != nil {
		if _, err := s.backups.SetDestination(r.Context(), in.Destination.update()); err != nil {
			bad("Could not use that backup destination: ", err)
			return
		}
	}
	if in.Schedule != nil {
		if _, err := s.backups.SetSchedule(r.Context(), *in.Schedule); err != nil {
			bad("Invalid schedule: ", err)
			return
		}
	}
	if in.Triggers != nil {
		if _, err := s.backups.SetTriggers(r.Context(), *in.Triggers); err != nil {
			bad("Invalid triggers: ", err)
			return
		}
	}
	writeJSON(w, s.logger, http.StatusOK, s.currentBackupSettings())
}

// handleTestBackupDestination — POST /api/v1/backups/destination/test
// Connects to a destination and round-trips a probe file without saving it.
// The response carries the destination as it would be stored (an SFTP host
// key fingerprint is filled in on first contact, for the administrator to
// compare before saving).
func (s *Server) handleTestBackupDestination(w http.ResponseWriter, r *http.Request, _ *auth.User) {
	var in destinationInput
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in); err != nil {
		writeError(w, s.logger, requestIDOrEmpty(r), http.StatusBadRequest, CodeBadRequest, "Invalid destination.")
		return
	}
	d, err := s.backups.TestDestination(r.Context(), in.update())
	out := struct {
		OK          bool              `json:"ok"`
		Error       string            `json:"error,omitempty"`
		Destination backupDestination `json:"destination"`
	}{OK: err == nil, Destination: toBackupDestination(d)}
	if err != nil {
		out.Error = err.Error()
	}
	writeJSON(w, s.logger, http.StatusOK, out)
}

// handleBackupStatus — GET /api/v1/backups/status
// The scheduler's state: whether a run is in progress, the next scheduled
// run, a run waiting for its destination, and data pending since the last
// backup (what the size triggers measure).
func (s *Server) handleBackupStatus(w http.ResponseWriter, r *http.Request, _ *auth.User) {
	writeJSON(w, s.logger, http.StatusOK, s.backups.SchedulerStatus(r.Context()))
}

// handleBackupDrives — GET /api/v1/backups/drives
// Mounted filesystems the server can write backups to.
func (s *Server) handleBackupDrives(w http.ResponseWriter, r *http.Request, _ *auth.User) {
	mounts, err := backups.ListMounts()
	if err != nil || mounts == nil {
		mounts = []backups.Mount{} // no mount table (non-Linux): nothing to offer
	}
	writeJSON(w, s.logger, http.StatusOK, mounts)
}
