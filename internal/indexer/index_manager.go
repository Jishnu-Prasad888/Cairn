// Package indexer - index_manager.go wires the library DB, scanner, and job
// queue together into a single IndexManager that callers (HTTP handlers,
// library manager) use.
package indexer

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"

	"github.com/Jishnu-Prasad888/Cairn/internal/jobs"
	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
)

// IndexStatus is the current state of a library's index.
type IndexStatus struct {
	LibraryID string    `json:"library_id"`
	Present   int       `json:"present"`
	Missing   int       `json:"missing"`
	Deleted   int       `json:"deleted"`
	ActiveJob *jobs.Job `json:"active_job,omitempty"`
	LastJobID string    `json:"last_job_id,omitempty"`
}

// IndexManager coordinates opening the per-library database, enqueueing scan
// jobs, and reporting index status. Each library gets its own job queue backed
// by its library.db.
type IndexManager struct {
	logger *slog.Logger
}

// NewIndexManager returns a new IndexManager.
func NewIndexManager(logger *slog.Logger) *IndexManager {
	return &IndexManager{logger: logger}
}

// openLibraryDB opens (and migrates) the library-level SQLite database for the
// library rooted at root. The .cairn directory must already exist.
func (m *IndexManager) openLibraryDB(root string) (*librarydb.DB, error) {
	cairnDir := filepath.Join(root, ".cairn")
	return librarydb.OpenDB(cairnDir)
}

// TriggerScan opens the library DB, resets any stuck jobs, and enqueues a new
// index scan job. Returns the job ID. It is safe to call even if a scan is
// already queued (a second scan will simply queue behind the first).
func (m *IndexManager) TriggerScan(ctx context.Context, libraryID, root string) (string, error) {
	ldb, err := m.openLibraryDB(root)
	if err != nil {
		return "", fmt.Errorf("open library db for %s: %w", libraryID, err)
	}
	defer func() { _ = ldb.Close() }()

	q := jobs.NewQueue(ldb.DB(), m.logger)
	if _, err := q.ResetStuck(ctx); err != nil {
		m.logger.Warn("reset stuck jobs", "library_id", libraryID, "error", err)
	}
	jobID, err := q.Enqueue(ctx, jobs.KindIndex, map[string]any{
		"library_id": libraryID,
		"root":       root,
	})
	if err != nil {
		return "", fmt.Errorf("enqueue scan job for %s: %w", libraryID, err)
	}
	m.logger.Info("scan job enqueued", "library_id", libraryID, "job_id", jobID)
	return jobID, nil
}

// Status returns the current index status for the library at root.
func (m *IndexManager) Status(ctx context.Context, libraryID, root string) (*IndexStatus, error) {
	ldb, err := m.openLibraryDB(root)
	if err != nil {
		return nil, fmt.Errorf("open library db for %s: %w", libraryID, err)
	}
	defer func() { _ = ldb.Close() }()

	store := NewStateStore(ldb.DB())
	present, missing, deleted, err := store.Counts(ctx)
	if err != nil {
		return nil, fmt.Errorf("count indexed files for %s: %w", libraryID, err)
	}

	status := &IndexStatus{
		LibraryID: libraryID,
		Present:   present,
		Missing:   missing,
		Deleted:   deleted,
	}

	// Find the most recent active job.
	q := jobs.NewQueue(ldb.DB(), m.logger)
	running, err := q.ListByStatus(ctx, jobs.StatusRunning)
	if err == nil && len(running) > 0 {
		status.ActiveJob = running[0]
		status.LastJobID = running[0].ID
	} else {
		queued, err := q.ListByStatus(ctx, jobs.StatusQueued)
		if err == nil && len(queued) > 0 {
			status.LastJobID = queued[0].ID
		}
	}
	return status, nil
}

// RunScanJob is the jobs.Handler for KindIndex. It reads the root from the job
// payload, opens the library DB, runs a full scanner pass, then enqueues
// process_media jobs for all new and modified files.
func (m *IndexManager) RunScanJob(ctx context.Context, job *jobs.Job) error {
	libraryID, _ := job.Payload["library_id"].(string)
	root, _ := job.Payload["root"].(string)
	if root == "" {
		return fmt.Errorf("index job %s missing root", job.ID)
	}

	cairnDir := root + "/.cairn"
	ldb, err := m.openLibraryDB(root)
	if err != nil {
		return fmt.Errorf("open library db: %w", err)
	}
	defer func() { _ = ldb.Close() }()

	store := NewStateStore(ldb.DB())
	scanner := NewScanner(store, m.logger)
	result, err := scanner.Scan(ctx, libraryID, root)
	if err != nil {
		return err
	}
	m.logger.Info("scan job finished",
		"library_id", libraryID,
		"total", result.TotalFiles,
		"new", result.NewFiles,
		"modified", result.Modified,
		"moved", result.Moved,
		"missing", result.Missing,
	)

	// Enqueue media-processing jobs for new and modified files.
	q := jobs.NewQueue(ldb.DB(), m.logger)
	enqueued := 0
	for _, change := range result.Changes {
		if change.Kind != ChangeNew && change.Kind != ChangeModified {
			continue
		}
		if _, err := q.Enqueue(ctx, jobs.KindProcessMedia, map[string]any{
			"library_id": libraryID,
			"file_id":    change.File.ID,
			"rel_path":   change.File.RelPath,
			"root":       root,
			"cairn_dir":  cairnDir,
		}); err != nil {
			m.logger.Warn("enqueue process_media job", "file_id", change.File.ID, "error", err)
		} else {
			enqueued++
		}
	}
	if enqueued > 0 {
		m.logger.Info("enqueued media processing jobs", "library_id", libraryID, "count", enqueued)
	}
	return nil
}
