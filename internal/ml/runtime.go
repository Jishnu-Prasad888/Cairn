package ml

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"
)

// settingKey is the server_settings row holding the master switch.
const settingKey = "ml.enabled"

// thresholdKey holds the administrator's face-matching threshold.
const thresholdKey = "ml.face_threshold"

// Target is a library a pass can run over.
type Target struct {
	ID     string
	Root   string
	Online bool
}

// Runtime owns the administrator-controlled ML master switch.
//
// The switch is stored in the server database, so it survives restarts and
// wins over the CAIRN_ML_ENABLED default once an administrator has used it.
// Turning it on enables similarity and people recognition together and
// immediately starts a pass over every online library; from then on every
// finished library scan (new uploads included) feeds new images through the
// same pipeline: detect faces, then match them to existing people by name or
// create "Person N" for anyone new. Turning it off stops all work; people,
// names and signatures already stored are kept.
type Runtime struct {
	db         *sql.DB
	logger     *slog.Logger
	sim        *Manager
	faces      *FaceManager
	similarity bool
	libraries  func(ctx context.Context) ([]Target, error)

	// run serializes passes so a scan finishing mid-backfill queues behind it
	// instead of decoding the same images twice.
	run sync.Mutex
}

// NewRuntime wires the switch to the managers. similarity says whether the
// similarity capability should run alongside people recognition.
func NewRuntime(db *sql.DB, logger *slog.Logger, sim *Manager, faces *FaceManager,
	similarity bool, libraries func(ctx context.Context) ([]Target, error)) *Runtime {
	return &Runtime{db: db, logger: logger, sim: sim, faces: faces, similarity: similarity, libraries: libraries}
}

// Enabled reports whether ML is currently on.
func (r *Runtime) Enabled() bool { return r.sim.Enabled() || r.faces.Enabled() }

func (r *Runtime) apply(on bool) {
	r.sim.SetEnabled(on)
	r.faces.SetEnabled(on)
}

// Load applies the stored switch, or def when the administrator never set one.
func (r *Runtime) Load(ctx context.Context, def bool) error {
	on := def
	var raw string
	err := r.db.QueryRowContext(ctx, `SELECT value FROM server_settings WHERE key = ?`, settingKey).Scan(&raw)
	switch {
	case err == nil:
		_ = json.Unmarshal([]byte(raw), &on)
	case errors.Is(err, sql.ErrNoRows):
	default:
		return err
	}
	r.apply(on)
	if err := r.db.QueryRowContext(ctx, `SELECT value FROM server_settings WHERE key = ?`, thresholdKey).Scan(&raw); err == nil {
		var v float64
		if json.Unmarshal([]byte(raw), &v) == nil {
			r.faces.SetThreshold(v)
		}
	}
	return nil
}

// SetFaceThreshold stores and applies the face-matching threshold (0 resets
// it to the recognition model's default) and regroups every online library
// with it in the background. Named people and hand-placed faces are kept.
func (r *Runtime) SetFaceThreshold(ctx context.Context, v float64) error {
	r.faces.SetThreshold(v)
	var err error
	if v <= 0 {
		_, err = r.db.ExecContext(ctx, `DELETE FROM server_settings WHERE key = ?`, thresholdKey)
	} else {
		raw, _ := json.Marshal(v)
		_, err = r.db.ExecContext(ctx, `
			INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			thresholdKey, string(raw), time.Now().UTC().Format(time.RFC3339Nano))
	}
	if err != nil {
		return err
	}
	if r.faces.Enabled() {
		r.regroupAll()
	}
	return nil
}

// regroupAll runs a grouping pass over every online library in the background.
func (r *Runtime) regroupAll() {
	go func() {
		libs, err := r.libraries(context.Background())
		if err != nil {
			r.logger.Warn("ml: list libraries", "error", err)
			return
		}
		for _, l := range libs {
			if !l.Online {
				continue
			}
			if _, err := r.faces.ClusterPass(context.Background(), l.Root); err != nil && !errors.Is(err, ErrFacesDisabled) {
				r.logger.Warn("ml: face grouping", "library_id", l.ID, "error", err)
			}
		}
	}()
}

// FaceThreshold reports the active threshold and the model's default.
func (r *Runtime) FaceThreshold() (current, def float64) {
	return r.faces.Threshold(), r.faces.DefaultThreshold()
}

// Set stores and applies the switch. Turning it on starts a pass over every
// online library in the background.
func (r *Runtime) Set(ctx context.Context, on bool) error {
	raw, _ := json.Marshal(on)
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		settingKey, string(raw), time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return err
	}
	r.apply(on)
	if on {
		r.StartAll()
	}
	return nil
}

// StartAll runs a pass over every online library in the background.
func (r *Runtime) StartAll() {
	go func() {
		libs, err := r.libraries(context.Background())
		if err != nil {
			r.logger.Warn("ml: list libraries", "error", err)
			return
		}
		for _, l := range libs {
			if l.Online {
				r.process(l.ID, l.Root)
			}
		}
	}()
}

// AfterScan is the indexer hook: new images are processed as they arrive. It
// returns immediately so the index worker is never held up by ML.
func (r *Runtime) AfterScan(libraryID, root string) {
	if !r.Enabled() {
		return
	}
	go r.process(libraryID, root)
}

// process runs similarity, face detection and clustering for one library.
func (r *Runtime) process(libraryID, root string) {
	r.run.Lock()
	defer r.run.Unlock()
	ctx := context.Background()
	if r.similarity && r.sim.Enabled() {
		if _, err := r.sim.Pass(ctx, libraryID, root); err != nil && !errors.Is(err, ErrDisabled) {
			r.logger.Warn("ml: similarity pass", "library_id", libraryID, "error", err)
		}
	}
	if r.faces.Enabled() {
		if _, err := r.faces.Pass(ctx, root); err != nil && !errors.Is(err, ErrFacesDisabled) {
			r.logger.Warn("ml: face pass", "library_id", libraryID, "error", err)
			return
		}
		if _, err := r.faces.ClusterPass(ctx, root); err != nil && !errors.Is(err, ErrFacesDisabled) {
			r.logger.Warn("ml: face clustering", "library_id", libraryID, "error", err)
		}
	}
}

// UsesFaceModel reports whether the learned face-recognition model is loaded.
func (r *Runtime) UsesFaceModel() bool { return r.faces.UsesEmbeddings() }

// ModelReady swaps in a freshly downloaded recognition model and, when ML is
// on, re-processes every online library with it.
func (r *Runtime) ModelReady(p *SCRFDEmbeddingFaceProvider) {
	r.faces.SetProvider(p)
	if r.Enabled() {
		r.StartAll()
	}
}
