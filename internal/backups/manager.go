package backups

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/library"
	"github.com/Jishnu-Prasad888/Cairn/internal/librarydb"
	"github.com/Jishnu-Prasad888/Cairn/internal/sanitize"
)

// Config drives the backup subsystem.
type Config struct {
	// Dir is the starting local destination directory (CAIRN_BACKUP_DIR). A
	// destination an administrator saved wins over it. Empty disables
	// backups until one is configured.
	Dir string

	// Keep is how many completed backups to retain; older ones are pruned.
	Keep int

	// Passphrase optionally encrypts every backup payload with the shared
	// AEAD kernel (AES-256-GCM via crypto.NewKeysFromKey, Phase 13/14).
	// Restore requires the same passphrase.
	Passphrase string

	// Interval is the starting scheduled cadence (CAIRN_BACKUP_INTERVAL_MIN);
	// a schedule an administrator saved wins over it. 0 disables it.
	Interval time.Duration

	// DataDir holds the key that seals remote-destination credentials.
	DataDir string
}

// Reasons a backup ran, recorded on each record.
const (
	ReasonManual   = "manual"
	ReasonSchedule = "schedule"
	ReasonSize     = "size"
)

// Manager orchestrates backups: the scheduler and size triggers, one-shot
// runs, sample verification, retention pruning, listing, and restore.
type Manager struct {
	db      *sql.DB
	logger  *slog.Logger
	libs    *library.Manager
	store   *Store
	cfg     Config
	server  string // absolute path of the server-level cairn.db
	secrets *secretBox

	// mu guards the administrator-editable policy below.
	mu       sync.RWMutex
	dest     Destination
	schedule Schedule
	anchor   time.Time // when the schedule was last changed
	lastFire time.Time // when the schedule last ran a backup (persisted)
	triggers Triggers

	busy    atomic.Bool
	skipped atomic.Int64
	trigger chan struct{}
	wake    chan struct{}

	// startupDelay holds back a missed scheduled run after start so the
	// server can settle (libraries come online, the indexer catches up).
	startupDelay time.Duration
	// retryDelay is how long a run waiting on an unavailable destination
	// waits before trying again.
	retryDelay time.Duration
	// sizeCheckEvery is the cadence of the new-data check; scans also nudge it.
	sizeCheckEvery time.Duration

	// open connects to a destination; tests replace it.
	open func(ctx context.Context, d Destination, onHostKey func(string)) (Target, error)

	stateMu sync.Mutex
	waiting string    // why a due run is waiting ("" = not waiting)
	nextTry time.Time // when the scheduler next looks again
}

// NewManager builds the backup manager. serverDB is the absolute path of the
// server-level cairn.db so it can be snapshotted.
func NewManager(db *sql.DB, logger *slog.Logger, libs *library.Manager, cfg Config, serverDB string) *Manager {
	if cfg.Keep <= 0 {
		cfg.Keep = 4
	}
	m := &Manager{
		db:             db,
		logger:         logger,
		libs:           libs,
		store:          NewStore(db),
		cfg:            cfg,
		server:         serverDB,
		secrets:        newSecretBox(cfg.DataDir),
		dest:           Destination{Kind: KindLocal, Path: cfg.Dir},
		schedule:       Schedule{Mode: ScheduleOff},
		trigger:        make(chan struct{}, 1),
		wake:           make(chan struct{}, 1),
		startupDelay:   time.Minute,
		retryDelay:     10 * time.Minute,
		sizeCheckEvery: 10 * time.Minute,
		open:           openTarget,
	}
	if cfg.Dir != "" {
		m.dest.MountPoint = MountPointFor(cfg.Dir)
	}
	if cfg.Interval > 0 {
		m.schedule = Schedule{Mode: ScheduleInterval, IntervalMinutes: int(cfg.Interval / time.Minute)}
	}
	return m
}

// Store exposes the backup record store for endpoint reads.
func (m *Manager) Store() *Store { return m.store }

// List returns the most recent backup records.
func (m *Manager) List(ctx context.Context, limit int) ([]Record, error) {
	return m.store.List(ctx, limit)
}

// Get returns one backup record.
func (m *Manager) Get(ctx context.Context, id string) (Record, error) {
	return m.store.Get(ctx, id)
}

// BackupConfig exposes the effective configuration (for the API response).
func (m *Manager) BackupConfig() Config {
	c := m.cfg
	c.Dir = m.Dir()
	return c
}

// Dir reports the local directory backups are written to; "" when backups
// are disabled or go to a remote destination.
func (m *Manager) Dir() string {
	d := m.Destination()
	if d.Kind != KindLocal {
		return ""
	}
	return d.Path
}

// Destination returns the current destination, credentials included.
func (m *Manager) Destination() Destination {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.dest
}

// Trigger requests a backup run from the scheduler (non-blocking).
func (m *Manager) Trigger() {
	select {
	case m.trigger <- struct{}{}:
	default:
		m.logger.Warn("backup trigger dropped: a run is already pending/running")
	}
}

// Nudge asks the scheduler to re-evaluate now: after settings change, and
// after an index scan so the size triggers see new files promptly.
func (m *Manager) Nudge() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

// AfterScan is the indexer hook; it has the indexer's signature.
func (m *Manager) AfterScan(string, string) { m.Nudge() }

// errBusy is returned when a run is refused because another is in progress.
var errBusy = errors.New("a backup is already running")

// Run performs one full backup synchronously and returns the record. It is
// safe to call from API handlers; concurrent runs are rejected.
func (m *Manager) Run(ctx context.Context) (*Record, error) {
	return m.runExclusive(ctx, ReasonManual)
}

func (m *Manager) runExclusive(ctx context.Context, reason string) (*Record, error) {
	if !m.busy.CompareAndSwap(false, true) {
		return nil, errBusy
	}
	defer m.busy.Store(false)
	return m.runBackup(ctx, reason)
}

// Running reports whether a backup is in progress.
func (m *Manager) Running() bool { return m.busy.Load() }

// RunBackup performs one full backup synchronously. Callers should normally
// use Run; this is exposed for tests.
func (m *Manager) RunBackup(ctx context.Context) (*Record, error) {
	return m.runBackup(ctx, ReasonManual)
}

// runBackup performs one backup. A destination that is not configured or
// cannot be reached is returned as an error without creating a record (the
// scheduler retries ErrUnavailable); anything that goes wrong once writing has
// started is recorded as a failed backup.
func (m *Manager) runBackup(ctx context.Context, reason string) (*Record, error) {
	r, err := m.begin(ctx, reason)
	if err != nil {
		return nil, err
	}
	defer func() { _ = r.tgt.Close() }()
	return m.complete(ctx, r)
}

// RunInBackground starts a backup and returns its running record as soon as
// the destination has been reached; the copy continues after the call
// returns. Problems reaching the destination are returned directly.
func (m *Manager) RunInBackground(ctx context.Context) (*Record, error) {
	if !m.busy.CompareAndSwap(false, true) {
		return nil, errBusy
	}
	r, err := m.begin(ctx, ReasonManual)
	if err != nil {
		m.busy.Store(false)
		return nil, err
	}
	started := *r.rec
	go func() {
		defer m.busy.Store(false)
		defer func() { _ = r.tgt.Close() }()
		bctx, cancel := context.WithTimeout(context.Background(), 12*time.Hour)
		defer cancel()
		rec, err := m.complete(bctx, r)
		if err != nil {
			m.logger.Error("background backup errored", "error", err)
			return
		}
		m.logger.Info("background backup finished", "backup_id", rec.ID, "status", rec.Status)
	}()
	return &started, nil
}

// pendingRun is a backup whose destination is open and record created.
type pendingRun struct {
	d      Destination
	tgt    Target
	rec    *Record
	folder string
}

// begin reaches the destination and creates the running record. A
// destination that is not configured or cannot be reached is an error and
// creates no record.
func (m *Manager) begin(ctx context.Context, reason string) (*pendingRun, error) {
	d := m.Destination()
	if !d.Configured() {
		return nil, errors.New("backup destination not configured; set one on the Backups page")
	}
	tgt, err := m.open(ctx, d, nil)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	m.skipped.Store(0)
	rec := &Record{
		ID:        newID(),
		Status:    StatusRunning,
		StartedAt: now,
		CreatedAt: now,
		ServerDB:  m.server,
		Reason:    reason,
	}
	if d.Kind != KindLocal {
		rec.Target = d.Key()
	}

	base := "cairn-backup-" + now.Format("20060102-150405")
	folder := base
	for i := 1; exists(tgt, path.Join(folder, "header.json")); i++ {
		folder = fmt.Sprintf("%s-%d", base, i)
	}
	rec.Destination = d.Location(folder)
	if err := m.store.Create(ctx, rec); err != nil {
		_ = tgt.Close()
		return nil, err
	}
	m.logger.Info("backup starting", "backup_id", rec.ID, "destination", rec.Destination, "reason", reason)
	return &pendingRun{d: d, tgt: tgt, rec: rec, folder: folder}, nil
}

// complete copies everything for a begun run, verifies a sample, and prunes.
// Failures along the way are recorded on the returned record.
func (m *Manager) complete(ctx context.Context, r *pendingRun) (*Record, error) {
	d, tgt, rec, folder := r.d, r.tgt, r.rec, r.folder
	now := rec.StartedAt
	if err := tgt.MkdirAll(folder); err != nil {
		m.fail(ctx, rec, fmt.Errorf("create backup folder: %w", err))
		return rec, nil
	}

	encrypted := m.cfg.Passphrase != ""
	var key []byte
	salt := hex.EncodeToString(newSalt())
	if encrypted {
		kb, err := hex.DecodeString(salt)
		if err != nil {
			m.fail(ctx, rec, fmt.Errorf("backup salt: %w", err))
			return rec, nil
		}
		key = deriveKey(m.cfg.Passphrase, kb)
	}
	if err := writeHeader(tgt, folder, encrypted, salt); err != nil {
		m.fail(ctx, rec, fmt.Errorf("write backup header: %w", err))
		return rec, nil
	}

	// Same-device warning: a local destination on the same volume as any
	// source. Remote destinations are by definition elsewhere.
	same := false
	var dstDev uint64
	local := d.Kind == KindLocal
	if local {
		dstDev, _ = deviceID(filepath.Join(d.Path, folder))
		if srcDev, ok := deviceID(filepath.Dir(m.server)); ok && dstDev == srcDev {
			same = true
		}
	}

	mf := &Manifest{
		Format:    "cairn-backup",
		Version:   1,
		CreatedAt: now,
		Encrypted: encrypted,
	}
	w := &writer{m: m, tgt: tgt, folder: folder, encrypted: encrypted, key: key}

	// 1. Server database.
	srv, err := m.snapshotServerDB(ctx, w)
	if err != nil {
		m.fail(ctx, rec, fmt.Errorf("server database: %w", err))
		return rec, nil
	}
	mf.ServerDB = &srv
	rec.Bytes = srv.Size

	// 2. Libraries: metadata + media.
	libs, err := m.libs.List(ctx)
	if err != nil {
		m.fail(ctx, rec, fmt.Errorf("list libraries: %w", err))
		return rec, nil
	}
	w.prev = m.loadPrevious(ctx, tgt, d, rec.ID)
	for _, lib := range libs {
		lf, err := m.backupLibrary(ctx, w, lib)
		if err != nil {
			m.fail(ctx, rec, fmt.Errorf("library %s: %w", lib.ID, err))
			return rec, nil
		}
		if local {
			if dev, ok := deviceID(lib.Root); ok && dstDev == dev {
				same = true
			}
		}
		mf.Libraries = append(mf.Libraries, lf)
		rec.Libraries++
		rec.Files += len(lf.Files)
		if lf.DB != nil {
			rec.Bytes += lf.DB.Size
		}
		if lf.Identity != nil {
			rec.Bytes += lf.Identity.Size
		}
		for _, e := range lf.Files {
			rec.Bytes += e.Size
		}
	}

	mfBytes, err := writeManifestTo(tgt, folder, mf, encrypted, key)
	if err != nil {
		m.fail(ctx, rec, fmt.Errorf("write manifest: %w", err))
		return rec, nil
	}
	rec.StoredBytes = w.stored + mfBytes

	rec.Status = StatusCompleted
	rec.Encrypted = encrypted
	rec.SameDevice = same
	rec.FilesSkipped = int(m.skipped.Load())
	rec.FinishedAt = time.Now().UTC()
	if err := m.store.Update(ctx, rec); err != nil {
		return nil, err
	}

	// 3. Sample verification (restore-a-sample integrity checks).
	if err := m.verifySample(ctx, rec, tgt, folder, mf, key); err != nil {
		m.logger.Warn("backup verification aborted", "backup_id", rec.ID, "error", err)
	}
	if err := m.store.Update(ctx, rec); err != nil {
		return nil, err
	}

	// 4. Retention pruning.
	m.prune(ctx, tgt, d, rec)
	m.logger.Info("backup completed", "backup_id", rec.ID,
		"files", rec.Files, "bytes", rec.Bytes, "stored_bytes", rec.StoredBytes,
		"skipped", rec.FilesSkipped, "verify_errors", rec.VerifyErrors)
	return rec, nil
}

// writer carries the state of one backup run's writes.
type writer struct {
	m         *Manager
	tgt       Target
	folder    string
	encrypted bool
	key       []byte
	prev      *prevBackup
	stored    int64 // bytes this backup occupies on the target (incl. reused)
	noLink    bool  // the target refused a hard link once; stop trying
}

// snapshotServerDB copies the server cairn.db into the backup after forcing a
// WAL checkpoint so the file is self-contained.
func (m *Manager) snapshotServerDB(ctx context.Context, w *writer) (Entry, error) {
	if m.server == "" {
		return Entry{}, errors.New("no server database path configured")
	}
	if _, err := m.db.ExecContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		return Entry{}, err
	}
	e, err := w.put(m.server, path.Join("server", "cairn.db"), true)
	if err != nil {
		return Entry{}, err
	}
	e.Original = m.server
	return e, nil
}

// snapshotLibraryDB checkpoints a library's metadata db and copies it.
func (m *Manager) snapshotLibraryDB(ctx context.Context, w *writer, libID, cairnDir string) (Entry, error) {
	dbPath := filepath.Join(cairnDir, "library.db")
	if _, err := os.Stat(dbPath); err != nil {
		return Entry{}, err
	}
	db, err := librarydb.Open(cairnDir)
	if err != nil {
		return Entry{}, err
	}
	_, _ = db.ExecContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)")
	_ = db.Close()
	return w.put(dbPath, path.Join("libraries", libID, "library.db"), true)
}

// backupLibrary copies one library's .cairn metadata and its media files.
func (m *Manager) backupLibrary(ctx context.Context, w *writer, lib library.Library) (LibraryBackup, error) {
	cairnDir := filepath.Join(lib.Root, ".cairn")
	lb := LibraryBackup{ID: lib.ID, Name: lib.Name, Root: lib.Root}

	dbEntry, err := m.snapshotLibraryDB(ctx, w, lib.ID, cairnDir)
	if err != nil {
		m.logger.Warn("library db backup skipped", "library_id", lib.ID, "error", err)
	} else {
		lb.DB = &dbEntry
	}

	idSrc := filepath.Join(cairnDir, "library.json")
	if _, err := os.Stat(idSrc); err == nil {
		entry, cerr := w.put(idSrc, path.Join("libraries", lib.ID, "library.json"), true)
		if cerr != nil {
			return lb, cerr
		}
		lb.Identity = &entry
	}

	walkErr := filepath.WalkDir(lib.Root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		rel := strings.TrimPrefix(p, lib.Root)
		rel = strings.TrimPrefix(rel, string(filepath.Separator))
		if rel == "" {
			return nil
		}
		if d.IsDir() {
			if rel == ".cairn" {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		fi, err := d.Info()
		if err != nil {
			return err
		}
		logical := path.Join("libraries", lib.ID, "files", filepath.ToSlash(rel))
		entry, err := w.putMedia(p, logical, fi)
		if err != nil {
			return err
		}
		lb.Files = append(lb.Files, entry)
		return nil
	})
	return lb, walkErr
}

// putMedia writes one media file into the backup. A file unchanged since the
// previous backup (same size and mtime, both unencrypted) is not copied
// again: it is hard-linked where the target supports that, and otherwise the
// entry references the earlier backup folder that holds the bytes.
func (w *writer) putMedia(srcPath, logical string, fi fs.FileInfo) (Entry, error) {
	if w.prev != nil && !w.encrypted {
		if pe, ok := w.prev.files[logical]; ok && pe.Size == fi.Size() && pe.MTime.Equal(fi.ModTime()) {
			if e, ok := w.reuse(srcPath, logical, fi, pe); ok {
				return e, nil
			}
		}
	}
	return w.put(srcPath, logical, shouldCompress(logical))
}

func (w *writer) reuse(srcPath, logical string, fi fs.FileInfo, pe Entry) (Entry, bool) {
	holder := pe.Ref
	if holder == "" {
		holder = w.prev.folder
	}
	src := path.Join(holder, logical)
	stored := pe.Stored
	if stored == 0 {
		// Manifests from before Stored was recorded.
		if n, err := w.tgt.Size(src); err == nil {
			stored = n
		}
	}
	e := Entry{
		Logical:    logical,
		Original:   srcPath,
		Size:       pe.Size,
		MTime:      fi.ModTime(),
		SHA256:     pe.SHA256,
		Compressed: pe.Compressed,
		Stored:     stored,
	}
	if l, ok := w.tgt.(linker); ok && !w.noLink {
		dst := path.Join(w.folder, logical)
		err := mkdirParent(w.tgt, dst)
		if err == nil {
			err = l.Link(src, dst)
		}
		switch {
		case err == nil:
			w.stored += stored
			w.m.skipped.Add(1)
			return e, true
		case errors.Is(err, fs.ErrNotExist):
			// The earlier copy is gone; write a fresh one.
			return Entry{}, false
		default:
			// exFAT/FAT USB drives and servers without the hardlink
			// extension: fall back to references for the rest of the run.
			w.m.logger.Info("backup target does not support hard links; referencing earlier backups instead",
				"error", err)
			w.noLink = true
		}
	}
	e.Ref = holder
	w.stored += stored
	w.m.skipped.Add(1)
	return e, true
}

// put streams src into the backup through the payload codec.
func (w *writer) put(srcPath, logical string, compress bool) (Entry, error) {
	e, err := copyFileEntry(w.tgt, srcPath, path.Join(w.folder, logical), logical, compress, w.encrypted, w.key)
	if err != nil {
		return Entry{}, err
	}
	w.stored += e.Stored
	return e, nil
}

// prevBackup is the most recent completed backup on the same destination,
// used for incremental runs.
type prevBackup struct {
	folder string
	files  map[string]Entry // media entries by logical path
}

// loadPrevious finds the most recent completed, reusable backup on the
// current destination. Encrypted backups are never reused (a fresh nonce
// re-encrypts everything each run).
func (m *Manager) loadPrevious(ctx context.Context, tgt Target, d Destination, currentID string) *prevBackup {
	if m.cfg.Passphrase != "" {
		return nil
	}
	recs, err := m.store.List(ctx, 50)
	if err != nil {
		return nil
	}
	for _, r := range recs {
		if r.ID == currentID || r.Status != StatusCompleted || r.Encrypted || !onDestination(r, d) {
			continue
		}
		folder := recordFolder(r)
		if !exists(tgt, path.Join(folder, manifestFilename)) {
			continue
		}
		mf, err := readManifestFrom(tgt, folder, nil)
		if err != nil {
			m.logger.Debug("previous backup manifest unreadable; full copy", "backup_id", r.ID, "error", err)
			return nil
		}
		p := &prevBackup{folder: folder, files: map[string]Entry{}}
		for _, lb := range mf.Libraries {
			for _, e := range lb.Files {
				p.files[e.Logical] = e
			}
		}
		return p
	}
	return nil
}

// onDestination reports whether a record was written to destination d.
func onDestination(r Record, d Destination) bool {
	if d.Kind == KindLocal {
		return r.Target == "" && filepath.Dir(r.Destination) == d.Path
	}
	return r.Target != "" && r.Target == d.Key()
}

// recordFolder is the backup folder name of a record, relative to its
// destination root.
func recordFolder(r Record) string {
	if r.Target == "" {
		return filepath.Base(r.Destination)
	}
	return path.Base(r.Destination)
}

// openRecord connects to the destination holding a record's backup. Local
// backups are reachable wherever they are; a remote backup only while its
// destination is the configured one (that is where the credentials are).
func (m *Manager) openRecord(ctx context.Context, r Record) (Target, string, error) {
	cur := m.Destination()
	if r.Target == "" {
		d := Destination{Kind: KindLocal, Path: filepath.Dir(r.Destination)}
		if cur.Kind == KindLocal && cur.Path == d.Path {
			d.MountPoint = cur.MountPoint
		}
		tgt, err := m.open(ctx, d, nil)
		return tgt, recordFolder(r), err
	}
	if cur.Kind == KindLocal || cur.Key() != r.Target {
		return nil, "", fmt.Errorf("this backup is on %s, which is no longer the configured destination", r.Target)
	}
	tgt, err := m.open(ctx, cur, nil)
	return tgt, recordFolder(r), err
}

// recordKey derives the payload key of an encrypted backup.
func (m *Manager) recordKey(tgt Target, folder string, encrypted bool, action string) ([]byte, error) {
	if !encrypted {
		return nil, nil
	}
	meta, err := readHeaderFrom(tgt, folder)
	if err != nil {
		return nil, err
	}
	if meta.Salt == "" {
		return nil, errors.New("backup is encrypted but its header has no salt")
	}
	if m.cfg.Passphrase == "" {
		return nil, fmt.Errorf("backup is encrypted; configure the same passphrase to %s", action)
	}
	salt, err := hex.DecodeString(meta.Salt)
	if err != nil {
		return nil, err
	}
	return deriveKey(m.cfg.Passphrase, salt), nil
}

// Verify re-checks a completed backup's integrity by restoring a sample of
// entries and comparing plaintext sizes/hashes. Rejected when the backup is
// encrypted but the configured passphrase differs.
func (m *Manager) Verify(ctx context.Context, id string) (*Record, error) {
	rec, err := m.store.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if rec.Status != StatusCompleted || rec.Destination == "" {
		return nil, errors.New("backup is not verifiable")
	}
	tgt, folder, err := m.openRecord(ctx, rec)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tgt.Close() }()
	key, err := m.recordKey(tgt, folder, rec.Encrypted, "verify")
	if err != nil {
		return nil, err
	}
	mf, err := readManifestFrom(tgt, folder, key)
	if err != nil {
		return nil, fmt.Errorf("read manifest: %w", err)
	}
	rec.VerifyStatus = ""
	rec.VerifyChecked = 0
	rec.VerifyErrors = 0
	if err := m.verifySample(ctx, &rec, tgt, folder, mf, key); err != nil {
		return nil, err
	}
	if err := m.store.Update(ctx, &rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

// verifySample runs the restore-a-sample stream verification and updates the
// record's per-sample counters.
func (m *Manager) verifySample(ctx context.Context, rec *Record, tgt Target, folder string, mf *Manifest, key []byte) error {
	checks := []Entry{}
	if mf.ServerDB != nil {
		checks = append(checks, *mf.ServerDB)
	}
	for _, lb := range mf.Libraries {
		if lb.DB != nil {
			checks = append(checks, *lb.DB)
		}
		if lb.Identity != nil {
			checks = append(checks, *lb.Identity)
		}
		for i := 0; i < len(lb.Files); i++ {
			if i < 3 || i%27 == 0 {
				checks = append(checks, lb.Files[i])
			}
		}
	}
	if len(checks) > 12 {
		checks = checks[:12]
	}
	rec.VerifyStatus = VerifyOK
	for _, e := range checks {
		if err := ctx.Err(); err != nil {
			return err
		}
		rec.VerifyChecked++
		if !verifyEntry(tgt, folder, e, key) {
			rec.VerifyErrors++
			rec.VerifyStatus = VerifyFail
			m.logger.Error("backup verification failed", "logical", e.Logical)
		}
	}
	return nil
}

// entryPath is where an entry's payload physically lives on the target.
func entryPath(folder string, e Entry) string {
	if e.Ref != "" {
		return path.Join(e.Ref, e.Logical)
	}
	return path.Join(folder, e.Logical)
}

// verifyEntry streams a stored payload back and compares the plaintext hash.
func verifyEntry(tgt Target, folder string, e Entry, key []byte) bool {
	src, err := tgt.Open(entryPath(folder, e))
	if err != nil {
		return false
	}
	defer func() { _ = src.Close() }()
	pr, err := openPayload(src, key)
	if err != nil {
		return false
	}
	if _, err := io.Copy(io.Discard, pr); err != nil {
		return false
	}
	if err := pr.Err(); err != nil {
		return false
	}
	return pr.Header().PlaintextSize == uint64(e.Size)
}

// Restore writes the contents of a completed backup into dest, a directory on
// the server, mirroring the stored layout (server/cairn.db, libraries/<id>/...).
func (m *Manager) Restore(ctx context.Context, id, dest string) (*Record, error) {
	rec, err := m.store.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if rec.Status != StatusCompleted || rec.Destination == "" {
		return nil, errors.New("backup is not restorable")
	}
	if dest == "" {
		return nil, errors.New("restore destination required")
	}
	tgt, folder, err := m.openRecord(ctx, rec)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tgt.Close() }()
	if err := os.MkdirAll(dest, 0o700); err != nil {
		return nil, err
	}
	key, err := m.recordKey(tgt, folder, rec.Encrypted, "restore")
	if err != nil {
		return nil, err
	}
	mf, err := readManifestFrom(tgt, folder, key)
	if err != nil {
		return nil, fmt.Errorf("read manifest: %w", err)
	}

	count := 0
	restoreAll := func(entries []Entry) error {
		for _, e := range entries {
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := restoreEntry(tgt, folder, dest, e, key); err != nil {
				return err
			}
			count++
		}
		return nil
	}
	if mf.ServerDB != nil {
		if err := restoreAll([]Entry{*mf.ServerDB}); err != nil {
			return nil, err
		}
	}
	for _, lb := range mf.Libraries {
		var entries []Entry
		if lb.DB != nil {
			entries = append(entries, *lb.DB)
		}
		if lb.Identity != nil {
			entries = append(entries, *lb.Identity)
		}
		entries = append(entries, lb.Files...)
		if err := restoreAll(entries); err != nil {
			return nil, err
		}
	}
	m.logger.Info("backup restored", "backup_id", id, "destination", dest, "entries", count)
	return &rec, nil
}

func (m *Manager) fail(ctx context.Context, rec *Record, err error) {
	rec.Status = StatusFailed
	rec.FinishedAt = time.Now().UTC()
	rec.ErrorMsg = err.Error()
	if uerr := m.store.Update(ctx, rec); uerr != nil {
		m.logger.Error("failed to persist backup failure", "error", uerr)
	}
}

// prune enforces the retention policy after a completed backup. Keep counts
// the total retained (including the current run); the oldest completed backups
// on the same destination beyond that are removed and their records marked
// pruned.
//
// Backups on targets without hard links reference unchanged files in earlier
// folders. A pruned folder that retained backups still reference keeps just
// those files (plus its header and manifest) and is removed entirely once
// nothing points into it any more.
func (m *Manager) prune(ctx context.Context, tgt Target, d Destination, current *Record) {
	recs, err := m.store.List(ctx, 500)
	if err != nil {
		return
	}
	sort.Slice(recs, func(i, j int) bool {
		return recs[i].CreatedAt.After(recs[j].CreatedAt)
	})
	var retained, expired, partial []Record
	retained = append(retained, *current)
	for _, r := range recs {
		if r.ID == current.ID || r.Destination == "" || !onDestination(r, d) {
			continue
		}
		switch {
		case r.Status == StatusCompleted && len(retained) < m.cfg.Keep:
			retained = append(retained, r)
		case r.Status == StatusCompleted:
			expired = append(expired, r)
		case r.Status == StatusPruned && r.KeptForRefs:
			partial = append(partial, r)
		}
	}
	if len(expired) == 0 && len(partial) == 0 {
		return
	}

	// Files retained backups still point at, by holding folder.
	live := map[string]map[string]bool{}
	for _, r := range retained {
		if r.Encrypted {
			continue // encrypted backups never reference other folders
		}
		mf, err := readManifestFrom(tgt, recordFolder(r), nil)
		if err != nil {
			// Without the manifest we cannot tell what it needs: keep
			// everything rather than risk deleting referenced files.
			m.logger.Warn("prune: retained manifest unreadable; skipping prune", "backup_id", r.ID, "error", err)
			return
		}
		for _, lb := range mf.Libraries {
			for _, e := range lb.Files {
				if e.Ref == "" {
					continue
				}
				if live[e.Ref] == nil {
					live[e.Ref] = map[string]bool{}
				}
				live[e.Ref][e.Logical] = true
			}
		}
	}

	for _, r := range expired {
		folder := recordFolder(r)
		r.Status = StatusPruned
		r.KeptForRefs = false
		if refs := live[folder]; len(refs) > 0 {
			if err := m.trimFolder(tgt, folder, refs, r.Encrypted); err != nil {
				m.logger.Warn("prune: trim backup failed", "backup_id", r.ID, "error", err)
				continue
			}
			r.KeptForRefs = true
		} else if err := tgt.RemoveAll(folder); err != nil {
			m.logger.Warn("prune: remove backup failed", "dir", r.Destination, "error", err)
			continue
		}
		if err := m.store.Update(ctx, &r); err != nil {
			m.logger.Warn("prune: update record failed", "backup_id", r.ID, "error", err)
		}
		m.logger.Info("pruned old backup", "backup_id", r.ID, "dir", r.Destination, "kept_for_refs", r.KeptForRefs)
	}
	for _, r := range partial {
		folder := recordFolder(r)
		if len(live[folder]) > 0 {
			continue
		}
		if err := tgt.RemoveAll(folder); err != nil {
			m.logger.Warn("prune: remove backup failed", "dir", r.Destination, "error", err)
			continue
		}
		r.KeptForRefs = false
		if err := m.store.Update(ctx, &r); err != nil {
			m.logger.Warn("prune: update record failed", "backup_id", r.ID, "error", err)
		}
		m.logger.Info("removed backup no longer referenced", "backup_id", r.ID, "dir", r.Destination)
	}
}

// trimFolder deletes the payloads of an expired backup that no retained
// backup references, keeping header.json and manifest.json.
func (m *Manager) trimFolder(tgt Target, folder string, keep map[string]bool, encrypted bool) error {
	if encrypted {
		return errors.New("encrypted backups are never referenced")
	}
	mf, err := readManifestFrom(tgt, folder, nil)
	if err != nil {
		return err
	}
	var drop []Entry
	if mf.ServerDB != nil {
		drop = append(drop, *mf.ServerDB)
	}
	for _, lb := range mf.Libraries {
		if lb.DB != nil {
			drop = append(drop, *lb.DB)
		}
		if lb.Identity != nil {
			drop = append(drop, *lb.Identity)
		}
		for _, e := range lb.Files {
			if e.Ref == "" && !keep[e.Logical] {
				drop = append(drop, e)
			}
		}
	}
	for _, e := range drop {
		// The manifest lives on the destination; never let a tampered one
		// steer a delete outside this backup folder.
		rel, err := sanitize.RelPath(e.Logical)
		if err != nil {
			m.logger.Warn("prune: unsafe manifest path skipped", "logical", e.Logical)
			continue
		}
		if err := tgt.Remove(path.Join(folder, rel)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			m.logger.Debug("prune: remove payload failed", "logical", e.Logical, "error", err)
		}
	}
	return nil
}

// --- helpers ---

func newSalt() []byte {
	b := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return fmt.Appendf(nil, "%016d", time.Now().UnixNano())
	}
	return b
}

func newID() string {
	b := make([]byte, 6)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return fmt.Sprintf("bkp-%d", time.Now().UnixNano())
	}
	return "bkp-" + hex.EncodeToString(b)
}

// copyFileEntry streams a local file into dstPath on the target through the
// payload codec.
func copyFileEntry(tgt Target, srcPath, dstPath, logical string, compress, encrypted bool, key []byte) (Entry, error) {
	src, err := os.Open(srcPath)
	if err != nil {
		return Entry{}, err
	}
	defer func() { _ = src.Close() }()
	fi, err := src.Stat()
	if err != nil {
		return Entry{}, err
	}
	sink, err := newPayloadSink(compress, encrypted, key)
	if err != nil {
		return Entry{}, err
	}
	defer sink.abort()
	if _, err := io.Copy(sink, src); err != nil {
		return Entry{}, err
	}
	if err := mkdirParent(tgt, dstPath); err != nil {
		return Entry{}, err
	}
	dst, err := tgt.Create(dstPath)
	if err != nil {
		return Entry{}, err
	}
	cw := &countingWriter{w: dst}
	hh, err := sink.Materialize(cw)
	if err != nil {
		_ = dst.Close()
		return Entry{}, err
	}
	if err := dst.Close(); err != nil {
		return Entry{}, err
	}
	return Entry{
		Logical:    logical,
		Original:   srcPath,
		Size:       fi.Size(),
		MTime:      fi.ModTime(),
		SHA256:     hh.SHA256Hex,
		Compressed: hh.Compressed,
		Encrypted:  hh.Encrypted,
		Stored:     cw.n,
	}, nil
}

// restoreEntry writes one stored payload back to plaintext under destBase,
// mirroring its logical path and restoring the original mtime. The logical path
// (and any reference) is validated so a crafted or tampered manifest cannot
// read or write outside the backup and the destination directory.
func restoreEntry(tgt Target, folder, destBase string, e Entry, key []byte) error {
	rel, err := sanitize.RelPath(e.Logical)
	if err != nil {
		return fmt.Errorf("unsafe manifest logical path %q: %w", e.Logical, err)
	}
	if e.Ref != "" && (strings.ContainsAny(e.Ref, `/\`) || e.Ref == "." || e.Ref == "..") {
		return fmt.Errorf("unsafe manifest reference %q", e.Ref)
	}
	dst := filepath.Join(destBase, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	src, err := tgt.Open(entryPath(folder, Entry{Logical: rel, Ref: e.Ref}))
	if err != nil {
		return err
	}
	defer func() { _ = src.Close() }()
	pr, err := openPayload(src, key)
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, pr); err != nil {
		_ = out.Close()
		return err
	}
	if err := pr.Err(); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Chtimes(dst, e.MTime, e.MTime)
}

var alreadyCompressedExt = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true,
	".avif": true, ".heic": true, ".heif": true, ".tiff": true, ".bmp": true,
	".mp4": true, ".m4v": true, ".mov": true, ".webm": true, ".mkv": true,
	".avi": true, ".wmv": true, ".flv": true, ".mpg": true, ".mpeg": true,
	".3gp": true, ".ts": true, ".m2ts": true,
	".mp3": true, ".aac": true, ".flac": true, ".ogg": true, ".opus": true,
	".wma": true, ".m4a": true, ".wav": true, ".aiff": true,
	".zip": true, ".gz": true, ".gzip": true, ".7z": true, ".rar": true,
	".tar": true, ".zst": true, ".tgz": true, ".xz": true, ".bz2": true,
}

// shouldCompress reports whether gzip is worth applying. Already-compressed
// formats are stored raw to avoid wasted CPU and needless expansion.
func shouldCompress(name string) bool {
	ext := strings.ToLower(name[strings.LastIndex(name, ".")+1:])
	if fi := filepath.Ext(name); fi != "" {
		ext = strings.ToLower(fi)
	}
	return !alreadyCompressedExt[ext]
}

// writeHeader writes header.json (always plaintext) into a backup folder.
func writeHeader(tgt Target, folder string, encrypted bool, salt string) error {
	h := headerMetadata{
		Format:    "cairn-backup",
		Version:   1,
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Encrypted: encrypted,
		Salt:      salt,
	}
	b, err := json.MarshalIndent(h, "", "  ")
	if err != nil {
		return err
	}
	return writeTargetFile(tgt, path.Join(folder, "header.json"), b)
}

// readHeaderFrom reads a backup folder's header.json.
func readHeaderFrom(tgt Target, folder string) (headerMetadata, error) {
	b, err := readTargetFile(tgt, path.Join(folder, "header.json"))
	if err != nil {
		return headerMetadata{}, err
	}
	var h headerMetadata
	if err := json.Unmarshal(b, &h); err != nil {
		return headerMetadata{}, err
	}
	return h, nil
}

// readHeader reads header.json from a local backup directory.
func readHeader(dest string) (headerMetadata, error) {
	return readHeaderFrom(newLocalTarget(filepath.Dir(dest)), filepath.Base(dest))
}

// writeManifestTo writes the manifest as a payload (encrypted when
// configured) and returns its stored size.
func writeManifestTo(tgt Target, folder string, mf *Manifest, encrypted bool, key []byte) (int64, error) {
	b, err := json.Marshal(mf)
	if err != nil {
		return 0, err
	}
	sink, err := newPayloadSink(true, encrypted, key)
	if err != nil {
		return 0, err
	}
	defer sink.abort()
	if _, err := sink.Write(b); err != nil {
		return 0, err
	}
	out, err := tgt.Create(path.Join(folder, manifestFilename))
	if err != nil {
		return 0, err
	}
	cw := &countingWriter{w: out}
	if _, err := sink.Materialize(cw); err != nil {
		_ = out.Close()
		return 0, err
	}
	return cw.n, out.Close()
}

// writeManifest writes a manifest into a local backup directory.
func writeManifest(dest string, mf *Manifest, encrypted bool, key []byte) error {
	_, err := writeManifestTo(newLocalTarget(filepath.Dir(dest)), filepath.Base(dest), mf, encrypted, key)
	return err
}

// readManifestFrom reads and decodes a backup folder's manifest.
func readManifestFrom(tgt Target, folder string, key []byte) (*Manifest, error) {
	f, err := tgt.Open(path.Join(folder, manifestFilename))
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	pr, err := openPayload(f, key)
	if err != nil {
		return nil, err
	}
	b, err := io.ReadAll(pr)
	if err != nil {
		return nil, err
	}
	if err := pr.Err(); err != nil {
		return nil, err
	}
	var mf Manifest
	if err := json.Unmarshal(b, &mf); err != nil {
		return nil, err
	}
	return &mf, nil
}

// readManifest reads the manifest of a local backup directory.
func readManifest(dest string, key []byte) (*Manifest, error) {
	return readManifestFrom(newLocalTarget(filepath.Dir(dest)), filepath.Base(dest), key)
}
