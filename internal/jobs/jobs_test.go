package jobs_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/jobs"
	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
)

func newTestQueue(t *testing.T) *jobs.Queue {
	t.Helper()
	cairnDir := filepath.Join(t.TempDir(), ".cairn")
	if err := os.MkdirAll(cairnDir, 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := librarydb.OpenDB(cairnDir)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return jobs.NewQueue(db.DB(), slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func newTestWorker(t *testing.T, q *jobs.Queue) *jobs.Worker {
	t.Helper()
	return jobs.NewWorker(q, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestEnqueueAndGet(t *testing.T) {
	q := newTestQueue(t)
	ctx := context.Background()

	id, err := q.Enqueue(ctx, jobs.KindIndex, map[string]any{"root": "/tmp/photos"})
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	if id == "" {
		t.Error("empty job id")
	}

	job, err := q.Get(ctx, id)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if job == nil {
		t.Fatal("Get returned nil")
	}
	if job.Status != jobs.StatusQueued {
		t.Errorf("status = %q, want queued", job.Status)
	}
	if job.Kind != jobs.KindIndex {
		t.Errorf("kind = %q, want %q", job.Kind, jobs.KindIndex)
	}
	if job.Payload["root"] != "/tmp/photos" {
		t.Errorf("payload root = %v", job.Payload["root"])
	}
}

func TestListByStatus(t *testing.T) {
	q := newTestQueue(t)
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		if _, err := q.Enqueue(ctx, jobs.KindIndex, nil); err != nil {
			t.Fatal(err)
		}
	}

	queued, err := q.ListByStatus(ctx, jobs.StatusQueued)
	if err != nil {
		t.Fatalf("ListByStatus: %v", err)
	}
	if len(queued) != 3 {
		t.Errorf("queued count = %d, want 3", len(queued))
	}

	completed, err := q.ListByStatus(ctx, jobs.StatusCompleted)
	if err != nil {
		t.Fatal(err)
	}
	if len(completed) != 0 {
		t.Errorf("completed = %d, want 0", len(completed))
	}
}

func TestCancel(t *testing.T) {
	q := newTestQueue(t)
	ctx := context.Background()

	id, _ := q.Enqueue(ctx, jobs.KindIndex, nil)
	if err := q.Cancel(ctx, id); err != nil {
		t.Fatalf("Cancel: %v", err)
	}

	job, _ := q.Get(ctx, id)
	if job.Status != jobs.StatusCancelled {
		t.Errorf("status = %q, want cancelled", job.Status)
	}
}

func TestResetStuck(t *testing.T) {
	q := newTestQueue(t)
	ctx := context.Background()

	// Manually insert a "running" job to simulate a stuck state.
	id, _ := q.Enqueue(ctx, jobs.KindIndex, nil)
	rawDB := q.RawDB()

	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := rawDB.ExecContext(ctx,
		`UPDATE index_jobs SET status = 'running', started_at = ? WHERE id = ?`,
		now, id); err != nil {
		t.Fatalf("set running: %v", err)
	}

	n, err := q.ResetStuck(ctx)
	if err != nil {
		t.Fatalf("ResetStuck: %v", err)
	}
	if n != 1 {
		t.Errorf("reset count = %d, want 1", n)
	}

	job, _ := q.Get(ctx, id)
	if job.Status != jobs.StatusQueued {
		t.Errorf("after reset status = %q, want queued", job.Status)
	}
}

func TestWorkerExecutesJob(t *testing.T) {
	q := newTestQueue(t)
	w := newTestWorker(t, q)
	ctx := context.Background()

	var executed atomic.Bool
	w.Register(jobs.KindIndex, func(_ context.Context, _ *jobs.Job) error {
		executed.Store(true)
		return nil
	})

	id, _ := q.Enqueue(ctx, jobs.KindIndex, nil)

	runCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if err := w.RunOnce(runCtx); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	if !executed.Load() {
		t.Error("handler not called")
	}

	job, _ := q.Get(ctx, id)
	if job.Status != jobs.StatusCompleted {
		t.Errorf("final status = %q, want completed", job.Status)
	}
}

func TestWorkerRetryOnFailure(t *testing.T) {
	q := newTestQueue(t)
	w := newTestWorker(t, q)
	ctx := context.Background()

	w.Register(jobs.KindIndex, func(_ context.Context, _ *jobs.Job) error {
		return errors.New("transient error")
	})

	id, _ := q.Enqueue(ctx, jobs.KindIndex, nil)

	runCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	// Execute the job once; it should fail and be re-queued for retry.
	if err := w.RunOnce(runCtx); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	job, _ := q.Get(ctx, id)
	// After one failure below max_attempts, should be back to queued.
	if job.Status != jobs.StatusQueued && job.Status != jobs.StatusFailed {
		t.Errorf("status after first failure = %q, want queued or failed", job.Status)
	}
	if job.ErrorMsg == "" {
		t.Error("error_msg should be set after failure")
	}
}

func TestWorkerPermanentFailure(t *testing.T) {
	q := newTestQueue(t)
	w := newTestWorker(t, q)
	ctx := context.Background()

	w.Register(jobs.KindIndex, func(_ context.Context, _ *jobs.Job) error {
		return errors.New("permanent error")
	})

	id, _ := q.Enqueue(ctx, jobs.KindIndex, nil)

	// Force max_attempts to 1 so a single failure results in permanent failure.
	rawDB := q.RawDB()
	if _, err := rawDB.ExecContext(ctx,
		`UPDATE index_jobs SET max_attempts = 1 WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}

	runCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if err := w.RunOnce(runCtx); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	job, _ := q.Get(ctx, id)
	if job.Status != jobs.StatusFailed {
		t.Errorf("status = %q, want failed", job.Status)
	}
}

// TestWorkerDrainsQueueWithoutPolling guards against working one job per poll
// tick: a backlog must run back to back.
func TestWorkerDrainsQueueWithoutPolling(t *testing.T) {
	q := newTestQueue(t)
	w := newTestWorker(t, q)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	const n = 20
	payloads := make([]map[string]any, n)
	if got, err := q.EnqueueAll(ctx, jobs.KindProcessMedia, payloads); err != nil || got != n {
		t.Fatalf("EnqueueAll = %d, %v", got, err)
	}
	var done atomic.Int32
	w.Register(jobs.KindProcessMedia, func(context.Context, *jobs.Job) error {
		done.Add(1)
		return nil
	})
	go w.Run(ctx)

	// One poll interval (2s) to start, then the rest without waiting.
	deadline := time.Now().Add(5 * time.Second)
	for done.Load() < n {
		if time.Now().After(deadline) {
			t.Fatalf("ran %d of %d jobs; the worker is waiting between jobs", done.Load(), n)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestWorkerConcurrencyKeepsScansExclusive runs media jobs in parallel while
// never letting two scans of one library overlap.
func TestWorkerConcurrencyKeepsScansExclusive(t *testing.T) {
	q := newTestQueue(t)
	w := newTestWorker(t, q)
	w.SetConcurrency(3)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	for range 3 {
		if _, err := q.Enqueue(ctx, jobs.KindIndex, nil); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := q.EnqueueAll(ctx, jobs.KindProcessMedia, make([]map[string]any, 6)); err != nil {
		t.Fatal(err)
	}

	var scans, maxScans, media, maxMedia, done atomic.Int32
	track := func(cur, peak *atomic.Int32) func(context.Context, *jobs.Job) error {
		return func(context.Context, *jobs.Job) error {
			n := cur.Add(1)
			for {
				p := peak.Load()
				if n <= p || peak.CompareAndSwap(p, n) {
					break
				}
			}
			time.Sleep(50 * time.Millisecond)
			cur.Add(-1)
			done.Add(1)
			return nil
		}
	}
	w.Register(jobs.KindIndex, track(&scans, &maxScans))
	w.Register(jobs.KindProcessMedia, track(&media, &maxMedia))
	go w.Run(ctx)

	deadline := time.Now().Add(10 * time.Second)
	for done.Load() < 9 {
		if time.Now().After(deadline) {
			t.Fatalf("finished %d of 9 jobs", done.Load())
		}
		time.Sleep(20 * time.Millisecond)
	}
	if maxScans.Load() != 1 {
		t.Errorf("%d scans ran at once; want 1", maxScans.Load())
	}
	if maxMedia.Load() < 2 {
		t.Errorf("media jobs never overlapped (peak %d); concurrency had no effect", maxMedia.Load())
	}
}
