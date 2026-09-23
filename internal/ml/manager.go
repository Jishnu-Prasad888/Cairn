package ml

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
)

// Config controls the ML manager. Everything is off unless Enabled is true.
type Config struct {
	// Enabled is the master switch: all ML capabilities are off until true.
	Enabled bool
	// Workers is the max concurrent files processed per similarity pass.
	Workers int
	// DistanceThreshold is the maximum Hamming distance (0-64) at or below
	// which files are reported as similar.
	DistanceThreshold int
}

// DefaultThreshold is the default similarity distance threshold.
const DefaultThreshold = 10

// Manager runs local ML passes over libraries. It is inert and stores nothing
// while ML is disabled. It is safe for concurrent use.
type Manager struct {
	logger   *slog.Logger
	cfg      Config
	provider Provider
}

// NewManager returns an ML manager for the given provider. The provider must
// be non-nil (callers use the average-hash provider as the default).
func NewManager(logger *slog.Logger, cfg Config, provider Provider) *Manager {
	if cfg.Workers <= 0 {
		cfg.Workers = 2
	}
	if cfg.DistanceThreshold == 0 {
		cfg.DistanceThreshold = DefaultThreshold
	}
	if provider == nil {
		provider = AverageHashProvider{}
	}
	return &Manager{logger: logger, cfg: cfg, provider: provider}
}

// Enabled reports whether ML is on.
func (m *Manager) Enabled() bool { return m.cfg.Enabled }

// ProviderName returns the active provider identifier (one provider is compiled
// in this phase; a registry follows when more exist).
func (m *Manager) ProviderName() string { return m.provider.Name() }

// ProviderVersion returns the active provider's algorithm version.
func (m *Manager) ProviderVersion() int { return m.provider.Version() }

// Pass computes signatures for every present image missing one, with bounded
// concurrency. Results are written per-file so a cancelled pass still makes
// progress and is fully resumable. Pass is safe to call concurrently with pass
// work from other goroutines. Returns the number of files processed.
func (m *Manager) Pass(ctx context.Context, libraryID, root string) (int, error) {
	if !m.Enabled() {
		return 0, ErrDisabled
	}

	db, err := openLibraryDB(root)
	if err != nil {
		return 0, err
	}
	defer func() { _ = db.Close() }()
	store := NewStore(db.DB())

	files, err := store.IDsWithoutSignature(ctx, m.provider.Name(), m.provider.Version())
	if err != nil {
		return 0, err
	}
	if len(files) == 0 {
		return 0, nil
	}

	m.logger.Info("ml pass started", "library_id", libraryID, "files", len(files))

	workers := m.cfg.Workers
	if workers > len(files) {
		workers = len(files)
	}
	jobs := make(chan UnsignedFile)
	var wg sync.WaitGroup
	var (
		mu        sync.Mutex
		processed int
		firstErr  error
	)

	start := time.Now()
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for uf := range jobs {
				if err := m.signature(ctx, store, root, uf); err != nil {
					m.logger.Warn("ml signature failed",
						"library_id", libraryID, "file_id", uf.FileID, "error", err)
					mu.Lock()
					if firstErr == nil {
						firstErr = err
					}
					mu.Unlock()
					return
				}
				mu.Lock()
				processed++
				mu.Unlock()
			}
		}()
	}

feed:
	for _, uf := range files {
		select {
		case <-ctx.Done():
			break feed
		case jobs <- uf:
		}
	}
	close(jobs)
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	elapsed := time.Since(start)
	m.logger.Info("ml pass finished", "library_id", libraryID,
		"processed", processed, "elapsed", elapsed.String())
	if firstErr != nil {
		return processed, firstErr
	}
	return processed, nil
}

// signature derives and stores a signature for one file, best-effort tolerant
// of undecodable or deleted files (they are simply skipped).
func (m *Manager) signature(ctx context.Context, store *Store, root string, uf UnsignedFile) error {
	abs := filepath.Join(root, filepath.FromSlash(uf.RelPath))
	img, err := openImage(abs)
	if err != nil {
		return err
	}
	sig, err := m.provider.Signature(img)
	if err != nil {
		return err
	}
	rec := SignatureRecord{
		FileID:    uf.FileID,
		Provider:  m.provider.Name(),
		Version:   m.provider.Version(),
		Signature: sig,
	}
	if err := store.Upsert(ctx, rec); err != nil {
		return err
	}
	return nil
}

// Status describes the current similarity state for a library.
type Status struct {
	LibraryID       string    `json:"library_id"`
	Enabled         bool      `json:"enabled"`
	Provider        string    `json:"provider"`
	ProviderVersion int       `json:"provider_version"`
	SigCount        int       `json:"signatured"`
	DistanceLimit   int       `json:"distance_limit"`
	LastPassAt      time.Time `json:"last_pass_at,omitempty"`
}

// Status reports the ML similarity state for the library at root.
func (m *Manager) Status(ctx context.Context, libraryID, root string) (*Status, error) {
	st := &Status{
		LibraryID:       libraryID,
		Enabled:         m.Enabled(),
		Provider:        m.ProviderName(),
		ProviderVersion: m.ProviderVersion(),
		DistanceLimit:   m.cfg.DistanceThreshold,
	}
	if !st.Enabled {
		return st, nil
	}
	db, err := openLibraryDB(root)
	if err != nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()
	n, err := NewStore(db.DB()).Count(ctx)
	if err != nil {
		return nil, err
	}
	st.SigCount = n
	return st, nil
}

// Similar returns files in the library whose signature is near the given
// file's, by Hamming distance, capped at limit and filtered by the configured
// distance threshold. distanceLimit == 0 means only exact-distance-0 filters
// apply; the manager's configured threshold is used when the caller passes a
// non-positive value via the API layer.
func (m *Manager) Similar(ctx context.Context, libraryID, root, fileID string, limit int) ([]SimilarHit, error) {
	if !m.Enabled() {
		return nil, ErrDisabled
	}
	db, err := openLibraryDB(root)
	if err != nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()
	store := NewStore(db.DB())

	rec, err := store.Get(ctx, fileID)
	if err != nil {
		return nil, err
	}
	if rec == nil {
		return nil, nil
	}
	hits, err := store.Similar(ctx, rec.Signature, limit, fileID)
	if err != nil {
		return nil, err
	}
	// Apply the configurable threshold. Zero distance always passes; we use
	// the manager-configured limit when the caller defaults to it.
	thr := m.cfg.DistanceThreshold
	out := hits[:0]
	for _, h := range hits {
		if h.Distance <= thr {
			out = append(out, h)
		}
	}
	return out, nil
}

// Purge deletes all derived similarity signatures for the library. Originals
// are untouched and the pass can regenerate them.
func (m *Manager) Purge(ctx context.Context, libraryID, root string) (int, error) {
	if !m.Enabled() {
		return 0, ErrDisabled
	}
	db, err := openLibraryDB(root)
	if err != nil {
		return 0, err
	}
	defer func() { _ = db.Close() }()
	store := NewStore(db.DB())
	n, err := store.Count(ctx)
	if err != nil {
		return 0, err
	}
	if err := store.Purge(ctx); err != nil {
		return 0, err
	}
	m.logger.Info("ml signatures purged", "library_id", libraryID, "count", n)
	return n, nil
}

// openLibraryDB opens (and migrates) the per-library database at root and
// must be closed by the caller.
func openLibraryDB(root string) (*librarydb.DB, error) {
	cairnDir := filepath.Join(root, ".cairn")
	return librarydb.OpenDB(cairnDir)
}

// ErrDisabled is returned by ML operations when ML is not enabled.
var ErrDisabled = errors.New("local ML is disabled")
