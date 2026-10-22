// Package jobs implements Cairn's persistent background job system.
//
// Jobs are written to the per-library SQLite database so they survive process
// restarts. A job that was running when the process stopped is reset to
// "queued" on startup. Workers pull queued jobs, execute them, and record the
// outcome.
//
// Design goals:
//   - Restart survival: all state lives in SQLite, never only in memory
//   - Bounded concurrency: configurable worker count (default 1); scans of a
//     library never run alongside each other
//   - Retries with exponential backoff
//   - Graceful shutdown: workers finish their current job then stop
package jobs

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
)

// Status values for a job record.
const (
	StatusQueued    = "queued"
	StatusRunning   = "running"
	StatusCompleted = "completed"
	StatusFailed    = "failed"
	StatusCancelled = "cancelled"
)

// KindIndex is the job kind for a library filesystem scan.
const KindIndex = "index"

// KindProcessMedia is the job kind for extracting metadata and generating
// thumbnails for a single media file.
const KindProcessMedia = "process_media"

// KindRenditions is the job kind that brings derived images forward for
// files processed before they existed: the small thumbnail and the
// placeholder colour.
const KindRenditions = "renditions"

// DefaultMaxAttempts is the default number of times a job is retried before
// being marked permanently failed.
const DefaultMaxAttempts = 3

// Job is one unit of background work stored in the database.
type Job struct {
	ID          string
	Kind        string
	Status      string
	Priority    int
	Payload     map[string]any
	Result      string
	ErrorMsg    string
	Attempt     int
	MaxAttempts int
	CreatedAt   time.Time
	StartedAt   time.Time
	FinishedAt  time.Time
	NextRunAt   time.Time
}

// Handler is a function that executes a job. It should respect ctx
// cancellation and return an error on failure.
type Handler func(ctx context.Context, job *Job) error

// Queue manages the job table in a per-library database.
type Queue struct {
	db     *sql.DB
	logger *slog.Logger
}

// NewQueue wraps a per-library database pool.
func NewQueue(db *sql.DB, logger *slog.Logger) *Queue {
	return &Queue{db: db, logger: logger}
}

// RawDB returns the underlying *sql.DB. Intended for tests only.
func (q *Queue) RawDB() *sql.DB { return q.db }

// Enqueue inserts a new job in the queued state. Returns the new job ID.
func (q *Queue) Enqueue(ctx context.Context, kind string, payload map[string]any) (string, error) {
	if payload == nil {
		payload = map[string]any{}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshal payload: %w", err)
	}
	id := newID()
	now := time.Now().UTC()
	const query = `
		INSERT INTO index_jobs
			(id, kind, status, priority, payload, attempt, max_attempts, created_at, next_run_at)
		VALUES (?, ?, 'queued', 0, ?, 0, ?, ?, ?)`
	if _, err := q.db.ExecContext(ctx, query, id, kind, string(raw),
		DefaultMaxAttempts, rfc3339(now), rfc3339(now)); err != nil {
		return "", fmt.Errorf("enqueue job: %w", err)
	}
	q.logger.Info("job enqueued", "job_id", id, "kind", kind)
	return id, nil
}

// EnqueueAll inserts one queued job of kind per payload, committing them in
// transactions of up to 500 so a large import is a handful of writes rather
// than one per file. It returns how many were enqueued; on error the jobs of
// earlier transactions stay queued.
func (q *Queue) EnqueueAll(ctx context.Context, kind string, payloads []map[string]any) (int, error) {
	const chunk = 500
	const query = `
		INSERT INTO index_jobs
			(id, kind, status, priority, payload, attempt, max_attempts, created_at, next_run_at)
		VALUES (?, ?, 'queued', 0, ?, 0, ?, ?, ?)`
	n := 0
	for start := 0; start < len(payloads); start += chunk {
		end := min(start+chunk, len(payloads))
		err := func() error {
			tx, err := q.db.BeginTx(ctx, nil)
			if err != nil {
				return err
			}
			defer func() { _ = tx.Rollback() }()
			stmt, err := tx.PrepareContext(ctx, query)
			if err != nil {
				return err
			}
			defer func() { _ = stmt.Close() }()
			for _, payload := range payloads[start:end] {
				if payload == nil {
					payload = map[string]any{}
				}
				raw, err := json.Marshal(payload)
				if err != nil {
					return fmt.Errorf("marshal payload: %w", err)
				}
				// created_at orders claims; time.Now per job keeps the
				// enqueue order even within one transaction.
				now := rfc3339(time.Now().UTC())
				if _, err := stmt.ExecContext(ctx, newID(), kind, string(raw),
					DefaultMaxAttempts, now, now); err != nil {
					return err
				}
			}
			return tx.Commit()
		}()
		if err != nil {
			return n, fmt.Errorf("enqueue jobs: %w", err)
		}
		n += end - start
	}
	if n > 0 {
		q.logger.Info("jobs enqueued", "kind", kind, "count", n)
	}
	return n, nil
}

// Get returns a single job by ID, or (nil, nil) when not found.
func (q *Queue) Get(ctx context.Context, id string) (*Job, error) {
	row := q.db.QueryRowContext(ctx,
		`SELECT id, kind, status, priority, payload, result, error_msg,
		        attempt, max_attempts, created_at, started_at, finished_at, next_run_at
		 FROM index_jobs WHERE id = ?`, id)
	return scanJob(row)
}

// FirstByStatus returns the oldest job with the given status, or nil.
func (q *Queue) FirstByStatus(ctx context.Context, status string) (*Job, error) {
	return scanJob(q.db.QueryRowContext(ctx,
		`SELECT id, kind, status, priority, payload, result, error_msg,
		        attempt, max_attempts, created_at, started_at, finished_at, next_run_at
		 FROM index_jobs WHERE status = ? ORDER BY created_at LIMIT 1`, status))
}

// HasActive reports whether a job of kind is queued or running.
func (q *Queue) HasActive(ctx context.Context, kind string) (bool, error) {
	var one int
	err := q.db.QueryRowContext(ctx,
		`SELECT 1 FROM index_jobs WHERE kind = ? AND status IN ('queued', 'running') LIMIT 1`,
		kind).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check active jobs: %w", err)
	}
	return true, nil
}

// ListByStatus returns all jobs with the given status, ordered by created_at.
func (q *Queue) ListByStatus(ctx context.Context, status string) ([]*Job, error) {
	rows, err := q.db.QueryContext(ctx,
		`SELECT id, kind, status, priority, payload, result, error_msg,
		        attempt, max_attempts, created_at, started_at, finished_at, next_run_at
		 FROM index_jobs WHERE status = ? ORDER BY created_at`, status)
	if err != nil {
		return nil, fmt.Errorf("list jobs: %w", err)
	}
	defer func() { _ = rows.Close() }()
	return scanJobs(rows)
}

// Cancel marks a queued or running job as cancelled.
func (q *Queue) Cancel(ctx context.Context, id string) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE index_jobs SET status = 'cancelled', finished_at = ?
		 WHERE id = ? AND status IN ('queued', 'running')`,
		rfc3339(time.Now().UTC()), id)
	return err
}

// ResetStuck resets any jobs that are stuck in the "running" state back to
// "queued". Called at startup to recover from a process crash.
func (q *Queue) ResetStuck(ctx context.Context) (int, error) {
	now := rfc3339(time.Now().UTC())
	res, err := q.db.ExecContext(ctx,
		`UPDATE index_jobs
		 SET status = 'queued', started_at = NULL, next_run_at = ?
		 WHERE status = 'running'`, now)
	if err != nil {
		return 0, fmt.Errorf("reset stuck jobs: %w", err)
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		q.logger.Info("reset stuck jobs", "count", n)
	}
	return int(n), nil
}

// Worker pulls jobs from the queue and executes them. It runs until the
// context is cancelled, then finishes its current job and returns.
type Worker struct {
	queue        *Queue
	handlers     map[string]Handler
	logger       *slog.Logger
	pollInterval time.Duration
	concurrency  int

	// claimMu serializes claims so the exclusive-kind check and the claim
	// itself happen as one step across this worker's goroutines.
	claimMu   sync.Mutex
	exclusive map[string]bool // kinds that never run alongside themselves
	running   map[string]int  // jobs of each kind running right now
}

// NewWorker constructs a Worker for the given queue.
func NewWorker(queue *Queue, logger *slog.Logger) *Worker {
	return &Worker{
		queue:        queue,
		handlers:     make(map[string]Handler),
		logger:       logger,
		pollInterval: 2 * time.Second,
		concurrency:  1,
		exclusive:    map[string]bool{KindIndex: true},
		running:      make(map[string]int),
	}
}

// SetConcurrency sets how many jobs Run executes at once (minimum 1). Jobs of
// an exclusive kind (a library scan) still run one at a time. Call before Run.
func (w *Worker) SetConcurrency(n int) {
	if n < 1 {
		n = 1
	}
	w.concurrency = n
}

// Register registers a handler for a job kind.
func (w *Worker) Register(kind string, h Handler) {
	w.handlers[kind] = h
}

// Run starts the worker loop. It blocks until ctx is cancelled.
//
// Queued jobs are worked through back to back; the poll interval is only
// slept when the queue has nothing runnable, so a large import is limited by
// the work itself rather than by one job per tick.
func (w *Worker) Run(ctx context.Context) {
	w.logger.Info("job worker started", "concurrency", w.concurrency)
	var wg sync.WaitGroup
	for i := 0; i < w.concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w.loop(ctx)
		}()
	}
	wg.Wait()
	w.logger.Info("job worker stopped")
}

func (w *Worker) loop(ctx context.Context) {
	timer := time.NewTimer(w.pollInterval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		for ctx.Err() == nil {
			err := w.processOne(ctx)
			if errors.Is(err, errNoJob) {
				break
			}
			if err != nil {
				w.logger.Error("job worker error", "error", err)
				break
			}
		}
		timer.Reset(w.pollInterval)
	}
}

// RunOnce processes exactly one queued job and returns. If no job is available
// it returns immediately. Intended for testing.
func (w *Worker) RunOnce(ctx context.Context) error {
	err := w.processOne(ctx)
	if errors.Is(err, errNoJob) {
		return nil
	}
	return err
}

var errNoJob = errors.New("no job available")

// processOne claims and executes exactly one queued job. Returns errNoJob
// when the queue is empty.
func (w *Worker) processOne(ctx context.Context) error {
	job, err := w.claim(ctx)
	if err != nil {
		return err
	}
	if job == nil {
		return errNoJob
	}
	defer w.finished(job.Kind)

	handler, ok := w.handlers[job.Kind]
	if !ok {
		w.logger.Error("no handler for job kind", "kind", job.Kind, "job_id", job.ID)
		return w.failJob(ctx, job, fmt.Sprintf("no handler registered for kind %q", job.Kind))
	}

	w.logger.Info("executing job", "job_id", job.ID, "kind", job.Kind, "attempt", job.Attempt)
	jobErr := handler(ctx, job)
	if jobErr != nil {
		return w.handleFailure(ctx, job, jobErr)
	}
	return w.completeJob(ctx, job)
}

// claim picks the next runnable job, skipping exclusive kinds that already
// have a job running in this worker, and records it as running.
func (w *Worker) claim(ctx context.Context) (*Job, error) {
	w.claimMu.Lock()
	defer w.claimMu.Unlock()
	var busy []string
	for kind := range w.exclusive {
		if w.running[kind] > 0 {
			busy = append(busy, kind)
		}
	}
	job, err := w.claimNext(ctx, busy)
	if err != nil || job == nil {
		return nil, err
	}
	w.running[job.Kind]++
	return job, nil
}

func (w *Worker) finished(kind string) {
	w.claimMu.Lock()
	w.running[kind]--
	w.claimMu.Unlock()
}

// claimNext atomically picks the next runnable job whose kind is not in skip
// and marks it running.
func (w *Worker) claimNext(ctx context.Context, skip []string) (*Job, error) {
	tx, err := w.queue.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin claim tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	now := time.Now().UTC()
	args := []any{rfc3339(now)}
	skipClause := ""
	if len(skip) > 0 {
		skipClause = " AND kind NOT IN (?" + strings.Repeat(", ?", len(skip)-1) + ")"
		for _, k := range skip {
			args = append(args, k)
		}
	}
	// Walks index_jobs_claim_idx in claim order, so the next job is found
	// without sorting every queued row.
	row := tx.QueryRowContext(ctx,
		`SELECT id, kind, status, priority, payload, result, error_msg,
		        attempt, max_attempts, created_at, started_at, finished_at, next_run_at
		 FROM index_jobs
		 WHERE status = 'queued' AND next_run_at <= ?`+skipClause+`
		 ORDER BY priority DESC, created_at
		 LIMIT 1`, args...)

	job, err := scanJob(row)
	if err != nil {
		return nil, err
	}
	if job == nil {
		return nil, nil
	}

	job.Attempt++
	job.Status = StatusRunning
	job.StartedAt = now
	_, err = tx.ExecContext(ctx,
		`UPDATE index_jobs SET status = 'running', attempt = ?, started_at = ? WHERE id = ?`,
		job.Attempt, rfc3339(now), job.ID)
	if err != nil {
		return nil, fmt.Errorf("claim job: %w", err)
	}
	return job, tx.Commit()
}

func (w *Worker) completeJob(ctx context.Context, job *Job) error {
	now := rfc3339(time.Now().UTC())
	_, err := w.queue.db.ExecContext(ctx,
		`UPDATE index_jobs SET status = 'completed', finished_at = ? WHERE id = ?`,
		now, job.ID)
	if err != nil {
		return fmt.Errorf("complete job: %w", err)
	}
	w.logger.Info("job completed", "job_id", job.ID, "kind", job.Kind)
	return nil
}

func (w *Worker) failJob(ctx context.Context, job *Job, errMsg string) error {
	now := rfc3339(time.Now().UTC())
	_, err := w.queue.db.ExecContext(ctx,
		`UPDATE index_jobs SET status = 'failed', error_msg = ?, finished_at = ? WHERE id = ?`,
		errMsg, now, job.ID)
	return err
}

// handleFailure decides whether to retry or permanently fail a job.
func (w *Worker) handleFailure(ctx context.Context, job *Job, jobErr error) error {
	w.logger.Warn("job failed", "job_id", job.ID, "kind", job.Kind,
		"attempt", job.Attempt, "max", job.MaxAttempts, "error", jobErr)

	if job.Attempt >= job.MaxAttempts {
		return w.failJob(ctx, job, jobErr.Error())
	}

	// Exponential backoff: 10s, 30s, 90s, …
	backoff := time.Duration(10*job.Attempt) * 3 * time.Second
	nextRun := rfc3339(time.Now().UTC().Add(backoff))
	_, err := w.queue.db.ExecContext(ctx,
		`UPDATE index_jobs SET status = 'queued', error_msg = ?, next_run_at = ? WHERE id = ?`,
		jobErr.Error(), nextRun, job.ID)
	return err
}

// --- row scanning helpers ---

type rowScanner interface {
	Scan(dest ...any) error
}

func scanJob(row rowScanner) (*Job, error) {
	var (
		j           Job
		result      sql.NullString
		errMsg      sql.NullString
		startedStr  sql.NullString
		finishedStr sql.NullString
		payloadStr  string
		createdStr  string
		nextRunStr  string
	)
	err := row.Scan(&j.ID, &j.Kind, &j.Status, &j.Priority, &payloadStr,
		&result, &errMsg, &j.Attempt, &j.MaxAttempts,
		&createdStr, &startedStr, &finishedStr, &nextRunStr)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("scan job: %w", err)
	}
	j.Result = result.String
	j.ErrorMsg = errMsg.String
	if err := json.Unmarshal([]byte(payloadStr), &j.Payload); err != nil {
		j.Payload = map[string]any{}
	}
	if err := parseTime(createdStr, &j.CreatedAt); err != nil {
		return nil, err
	}
	if startedStr.Valid {
		if err := parseTime(startedStr.String, &j.StartedAt); err != nil {
			return nil, err
		}
	}
	if finishedStr.Valid {
		if err := parseTime(finishedStr.String, &j.FinishedAt); err != nil {
			return nil, err
		}
	}
	if err := parseTime(nextRunStr, &j.NextRunAt); err != nil {
		return nil, err
	}
	return &j, nil
}

func scanJobs(rows *sql.Rows) ([]*Job, error) {
	var out []*Job
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

func rfc3339(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

func parseTime(s string, out *time.Time) error {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return fmt.Errorf("parse time %q: %w", s, err)
	}
	*out = t
	return nil
}

func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("fallback-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}
