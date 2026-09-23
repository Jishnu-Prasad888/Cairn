package ml

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
)

// FaceConfig controls the local face capability off the Phase 11 ML seam.
// Everything is off unless FaceConfig.Enabled (CAIRN_ML_FACES) is true, which
// in turn requires the master ML switch (CAIRN_ML_ENABLED).
type FaceConfig struct {
	// Enabled gates this capability independently of similarity.
	Enabled bool
	// Workers is the max concurrent files scanned per face pass.
	Workers int
	// Version is the detector algorithm version consulted for stored rows.
	MinConfidence float64
	MinSize       int
	// Threshold is the minimum cosine similarity (0..1) for an unassigned
	// face to join an existing person.
	Threshold float64
}

// Defaults for face recognition. MinConfidence maps to pigo's raw score ~5
// (normalized by /100).
const (
	DefaultFaceWorkers       = 2
	DefaultFaceMinConfidence = 0.05
	DefaultFaceMinSize       = 60
	DefaultFaceThreshold     = 0.82
)

// ErrFacesDisabled is returned by face operations when the capability is off.
var ErrFacesDisabled = errors.New("local face recognition is disabled")

// FaceManager runs the face capability: detection passes, clustering passes,
// people curation, and privacy purges. It is inert while disabled and safe
// for concurrent use.
type FaceManager struct {
	logger   *slog.Logger
	cfg      FaceConfig
	provider FaceProvider
}

// NewFaceManager returns a face manager using provider (defaults to the
// built-in PigoFaceProvider). Zero config values become the defaults.
func NewFaceManager(logger *slog.Logger, cfg FaceConfig, provider FaceProvider) *FaceManager {
	if cfg.Workers <= 0 {
		cfg.Workers = DefaultFaceWorkers
	}
	if cfg.MinConfidence <= 0 {
		cfg.MinConfidence = DefaultFaceMinConfidence
	}
	if cfg.MinSize <= 0 {
		cfg.MinSize = DefaultFaceMinSize
	}
	if cfg.Threshold <= 0 || cfg.Threshold > 1 {
		cfg.Threshold = DefaultFaceThreshold
	}
	if provider == nil {
		provider = NewPigoFaceProvider(cfg.MinSize, cfg.MinConfidence)
	} else if p, ok := provider.(*PigoFaceProvider); ok {
		p.MinSize = cfg.MinSize
		p.MinConfidence = cfg.MinConfidence
	}
	return &FaceManager{logger: logger, cfg: cfg, provider: provider}
}

// Enabled reports whether the face capability is on.
func (m *FaceManager) Enabled() bool { return m.cfg.Enabled }

// ProviderName returns the active face provider identifier.
func (m *FaceManager) ProviderName() string { return m.provider.Name() }

// ProviderVersion returns the active face provider's algorithm version.
func (m *FaceManager) ProviderVersion() int { return m.provider.Version() }

// FaceStatus describes the current face state for a library.
type FaceStatus struct {
	Enabled         bool   `json:"enabled"`
	Provider        string `json:"provider"`
	ProviderVersion int    `json:"provider_version"`
	Faces           int    `json:"faces"`
	People          int    `json:"people"`
	Unassigned      int    `json:"unassigned"`
}

// Status reports the face state for the library at root.
func (m *FaceManager) Status(ctx context.Context, root string) (*FaceStatus, error) {
	st := &FaceStatus{
		Enabled:         m.Enabled(),
		Provider:        m.provider.Name(),
		ProviderVersion: m.provider.Version(),
	}
	if !st.Enabled {
		return st, nil
	}
	db, err := openLibraryDB(root)
	if err != nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()
	store := NewFaceStore(db.DB())

	if st.Faces, err = store.CountFaces(ctx); err != nil {
		return nil, err
	}
	if st.People, err = store.CountPeople(ctx); err != nil {
		return nil, err
	}
	unassigned, err := store.FacesUnassigned(ctx)
	if err != nil {
		return nil, err
	}
	st.Unassigned = len(unassigned)
	return st, nil
}

// Pass runs face detection over every present photo missing a signature for
// the current provider version, with bounded concurrency, writing one face
// row per detection. Files that decode or detect nothing are skipped and
// retried on the next pass. Returns the number of files scanned.
func (m *FaceManager) Pass(ctx context.Context, root string) (int, error) {
	if !m.Enabled() {
		return 0, ErrFacesDisabled
	}
	db, err := openLibraryDB(root)
	if err != nil {
		return 0, err
	}
	defer func() { _ = db.Close() }()
	store := NewFaceStore(db.DB())

	files, err := store.FilesToScan(ctx, m.provider.Name(), m.provider.Version())
	if err != nil {
		return 0, err
	}
	if len(files) == 0 {
		return 0, nil
	}

	workers := m.cfg.Workers
	if workers > len(files) {
		workers = len(files)
	}
	jobs := make(chan UnsignedFaceFile)
	var wg sync.WaitGroup
	var (
		mu        sync.Mutex
		scanned   int
		firstErr  error
	)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for uf := range jobs {
				if err := m.scanFile(ctx, store, root, uf); err != nil {
					mu.Lock()
					if firstErr == nil {
						firstErr = err
					}
					mu.Unlock()
					return
				}
				mu.Lock()
				scanned++
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
	if firstErr != nil {
		return scanned, firstErr
	}
	return scanned, nil
}

// scanFile detects faces in one file and stores them.
func (m *FaceManager) scanFile(ctx context.Context, store *FaceStore, root string, uf UnsignedFaceFile) error {
	abs := filepath.Join(root, filepath.FromSlash(uf.RelPath))
	img, err := openImage(abs)
	if err != nil {
		return err
	}
	boxes, err := m.provider.Detect(img)
	if err != nil {
		return err
	}
	for _, box := range boxes {
		desc, err := m.provider.Embed(img, box)
		if err != nil {
			return err
		}
		id, err := newID()
		if err != nil {
			return err
		}
		if err := store.InsertFace(ctx, FaceRecord{
			ID:       id,
			FileID:   uf.FileID,
			Provider: m.provider.Name(),
			Version:  m.provider.Version(),
			Box:      box,
			Descriptor: desc,
		}); err != nil {
			return err
		}
	}
	return nil
}

// FaceClusterResult reports a clustering pass outcome.
type FaceClusterResult struct {
	Inspected int `json:"inspected"`
	Assigned  int `json:"assigned"`
	Created   int `json:"created"`
}

// ClusterPass incrementally groups unassigned faces into people: each face is
// matched against existing people (by mean descriptor similarity); matches at
// or above Threshold join the person, otherwise a new person is created
// ("Person N"). All assignments are stored as 'auto'; manual assignments are
// never touched, and people with no faces (post-purge) are skipped. The
// unassigned set is processed oldest-first so results are deterministic.
func (m *FaceManager) ClusterPass(ctx context.Context, root string) (*FaceClusterResult, error) {
	if !m.Enabled() {
		return nil, ErrFacesDisabled
	}
	db, err := openLibraryDB(root)
	if err != nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()
	store := NewFaceStore(db.DB())

	unassigned, err := store.FacesUnassigned(ctx)
	if err != nil {
		return nil, err
	}
	if len(unassigned) == 0 {
		return &FaceClusterResult{}, nil
	}
	means, err := store.PersonMeans(ctx)
	if err != nil {
		return nil, err
	}
	peopleCount, err := store.CountPeople(ctx)
	if err != nil {
		return nil, err
	}

	res := &FaceClusterResult{Inspected: len(unassigned)}
	next := peopleCount + 1
	for _, f := range unassigned {
		var bestID string
		bestSim := float64(0)
		for pid, mean := range means {
			if sim := DescriptorCosine(f.Descriptor, mean); sim > bestSim {
				bestSim = sim
				bestID = pid
			}
		}
		if bestID != "" && bestSim >= m.cfg.Threshold {
			if err := store.AssignPerson(ctx, bestID, f.ID, "auto"); err != nil {
				return res, err
			}
			res.Assigned++
		} else {
			name := fmt.Sprintf("Person %d", next)
			next++
			p, err := store.CreatePerson(ctx, name)
			if err != nil {
				return res, err
			}
			if err := store.SetCover(ctx, p.ID, f.ID); err != nil {
				return res, err
			}
			if err := store.AssignPerson(ctx, p.ID, f.ID, "auto"); err != nil {
				return res, err
			}
			means[p.ID] = f.Descriptor
			res.Created++
		}
	}
	m.logger.Info("face clustering finished", "inspected", res.Inspected,
		"assigned", res.Assigned, "created", res.Created)
	return res, nil
}

// People lists people with their face counts.
func (m *FaceManager) People(ctx context.Context, root string) ([]Person, error) {
	if !m.Enabled() {
		return nil, ErrFacesDisabled
	}
	db, err := openLibraryDB(root)
	if err != nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()
	return NewFaceStore(db.DB()).ListPeople(ctx)
}

// PersonFaces lists the faces assigned to a person.
func (m *FaceManager) PersonFaces(ctx context.Context, root, personID string) ([]FaceRecord, error) {
	if !m.Enabled() {
		return nil, ErrFacesDisabled
	}
	db, err := openLibraryDB(root)
	if err != nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()
	return NewFaceStore(db.DB()).PersonFaces(ctx, personID)
}

// Unassigned lists faces that belong to no person.
func (m *FaceManager) Unassigned(ctx context.Context, root string) ([]FaceRecord, error) {
	if !m.Enabled() {
		return nil, ErrFacesDisabled
	}
	db, err := openLibraryDB(root)
	if err != nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()
	faces, err := NewFaceStore(db.DB()).FacesUnassigned(ctx)
	if err != nil {
		return nil, err
	}
	if faces == nil {
		faces = []FaceRecord{}
	}
	return faces, nil
}

// CreatePerson is a pass-through used by the API for manual curation.
func (m *FaceManager) CreatePerson(ctx context.Context, root, name string) (*Person, error) {
	if !m.Enabled() {
		return nil, ErrFacesDisabled
	}
	db, err := openLibraryDB(root)
	if err != nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()
	p, err := NewFaceStore(db.DB()).CreatePerson(ctx, name)
	if err != nil {
		return nil, err
	}
	m.logger.Info("person created", "person_id", p.ID, "name", name)
	return p, nil
}

// RenamePerson updates a person's display name.
func (m *FaceManager) RenamePerson(ctx context.Context, root, personID, name string) error {
	if !m.Enabled() {
		return ErrFacesDisabled
	}
	db, err := openLibraryDB(root)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	return NewFaceStore(db.DB()).RenamePerson(ctx, personID, name)
}

// DeletePerson removes a person (and their assignments, not their faces).
func (m *FaceManager) DeletePerson(ctx context.Context, root, personID string) error {
	if !m.Enabled() {
		return ErrFacesDisabled
	}
	db, err := openLibraryDB(root)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	return NewFaceStore(db.DB()).DeletePerson(ctx, personID)
}

// MergePerson folds source into keep (used for consolidating duplicates).
func (m *FaceManager) MergePerson(ctx context.Context, root, keepID, sourceID string) error {
	if !m.Enabled() {
		return ErrFacesDisabled
	}
	db, err := openLibraryDB(root)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	return NewFaceStore(db.DB()).Merge(ctx, keepID, sourceID)
}

// AssignFace manually attaches a face to a person.
func (m *FaceManager) AssignFace(ctx context.Context, root, personID, faceID string) error {
	if !m.Enabled() {
		return ErrFacesDisabled
	}
	db, err := openLibraryDB(root)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	return NewFaceStore(db.DB()).AssignPerson(ctx, personID, faceID, "manual")
}

// UnassignFace frees a face from a person (it becomes cluster-eligible).
func (m *FaceManager) UnassignFace(ctx context.Context, root, personID, faceID string) error {
	if !m.Enabled() {
		return ErrFacesDisabled
	}
	db, err := openLibraryDB(root)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	return NewFaceStore(db.DB()).UnassignPerson(ctx, personID, faceID)
}

// Purge deletes every derived face and assignment for the library, keeping
// people (names) intact. Returns the number of faces removed.
func (m *FaceManager) Purge(ctx context.Context, root string) (int, error) {
	if !m.Enabled() {
		return 0, ErrFacesDisabled
	}
	db, err := openLibraryDB(root)
	if err != nil {
		return 0, err
	}
	defer func() { _ = db.Close() }()
	n, err := NewFaceStore(db.DB()).PurgeFaces(ctx)
	if err != nil {
		return 0, err
	}
	m.logger.Info("face data purged", "count", n)
	return n, nil
}