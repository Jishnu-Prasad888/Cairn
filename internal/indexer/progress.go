package indexer

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/jobs"
)

// Scan phases reported while a scan runs.
const (
	// PhaseCounting is the quick first walk that only lists directories, so
	// that every folder's size is known before any file is read.
	PhaseCounting = "counting"
	// PhaseScanning is the walk that stats, hashes and records files.
	PhaseScanning = "scanning"
)

// Folder states in a progress tree.
const (
	FolderWaiting    = "waiting"    // the running scan has not reached it yet
	FolderScanning   = "scanning"   // the running scan is inside it
	FolderProcessing = "processing" // scanned; metadata and thumbnails still queued
	FolderDone       = "done"
)

// ScanProgress follows one running scan of a library: how many files each
// directory holds (from the counting walk) and how many of them the scan has
// gone through. It lives in memory only; a restarted server rebuilds it when
// the resumed scan runs. Safe for concurrent use.
type ScanProgress struct {
	mu        sync.Mutex
	phase     string
	startedAt time.Time
	current   string                // directory the scan is in
	dirs      map[string]*dirCounts // keyed by slash-separated rel dir, "" = root
}

type dirCounts struct{ total, done int }

func newScanProgress() *ScanProgress {
	return &ScanProgress{
		phase:     PhaseCounting,
		startedAt: time.Now().UTC(),
		dirs:      map[string]*dirCounts{"": {}},
	}
}

// relDir returns the directory of a slash-separated relative file path, with
// the library root as "".
func relDir(relPath string) string {
	d := path.Dir(relPath)
	if d == "." || d == "/" {
		return ""
	}
	return d
}

func (p *ScanProgress) dir(d string) *dirCounts {
	c, ok := p.dirs[d]
	if !ok {
		c = &dirCounts{}
		p.dirs[d] = c
	}
	return c
}

// count walks root listing directories only — no file is opened or statted
// — and records how many files each directory holds. It mirrors the scan's
// walk, so the totals match what the scan will visit.
func (p *ScanProgress) count(ctx context.Context, root string) error {
	totals := map[string]*dirCounts{"": {}}
	err := filepath.WalkDir(root, func(absPath string, d os.DirEntry, err error) error {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if err != nil {
			return nil // the scan reports it
		}
		rel, relErr := filepath.Rel(root, absPath)
		if relErr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if d.Name() == cairnDirName {
				return filepath.SkipDir
			}
			if rel != "." {
				if _, ok := totals[rel]; !ok {
					totals[rel] = &dirCounts{}
				}
			}
			return nil
		}
		dir := relDir(rel)
		c, ok := totals[dir]
		if !ok {
			c = &dirCounts{}
			totals[dir] = c
		}
		c.total++
		return nil
	})
	p.mu.Lock()
	p.dirs = totals
	p.phase = PhaseScanning
	p.mu.Unlock()
	return err
}

// enter records that the scan moved into directory rel.
func (p *ScanProgress) enter(rel string) {
	p.mu.Lock()
	p.current = rel
	p.dir(rel)
	p.mu.Unlock()
}

// fileDone records that the scan has dealt with one file at relPath.
func (p *ScanProgress) fileDone(relPath string) {
	p.mu.Lock()
	c := p.dir(relDir(relPath))
	c.done++
	if c.done > c.total {
		c.total = c.done // a file that appeared after the counting walk
	}
	p.mu.Unlock()
}

// Under returns how many files the scan expects in folder (and everything
// beneath it) and how many it has gone through so far. ok is false while
// the counting walk is still running.
func (p *ScanProgress) Under(folder string) (total, done int, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.phase == PhaseCounting {
		return 0, 0, false
	}
	prefix := folder + "/"
	for d, c := range p.dirs {
		if folder == "" || d == folder || strings.HasPrefix(d, prefix) {
			total += c.total
			done += c.done
		}
	}
	return total, done, true
}

// snapshot copies the per-directory counts.
func (p *ScanProgress) snapshot() (phase, current string, startedAt time.Time, dirs map[string]dirCounts) {
	p.mu.Lock()
	defer p.mu.Unlock()
	dirs = make(map[string]dirCounts, len(p.dirs))
	for d, c := range p.dirs {
		dirs[d] = *c
	}
	return p.phase, p.current, p.startedAt, dirs
}

// --- progress report ---

// Progress is a library's indexing progress as a folder tree.
type Progress struct {
	LibraryID string `json:"library_id"`
	// Scan describes the running scan; nil when none is running.
	Scan *ScanState `json:"scan,omitempty"`
	// ScanQueued is true when a scan is waiting to start.
	ScanQueued bool `json:"scan_queued"`
	// MediaPending counts files whose metadata and thumbnail are still queued.
	MediaPending int `json:"media_pending"`
	// MediaFailed counts files whose processing gave up after its retries.
	MediaFailed int `json:"media_failed"`
	// Root is the library root and its folders.
	Root *FolderProgress `json:"root"`
}

// ScanState is the running scan's position.
type ScanState struct {
	Phase         string    `json:"phase"`
	StartedAt     time.Time `json:"started_at"`
	CurrentFolder string    `json:"current_folder"`
	FilesTotal    int       `json:"files_total"`
	FilesScanned  int       `json:"files_scanned"`
}

// FolderProgress is one folder in the progress tree. Counts cover the folder
// and everything beneath it.
type FolderProgress struct {
	Path string `json:"path"`
	Name string `json:"name"`
	// Files is how many files the folder holds: the running scan's count
	// when there is one, otherwise the files in the index.
	Files int `json:"files"`
	// Scanned is how many of them the running scan has gone through; equal
	// to Files when no scan is running.
	Scanned      int               `json:"scanned"`
	MediaPending int               `json:"media_pending"`
	MediaFailed  int               `json:"media_failed"`
	Status       string            `json:"status"`
	Children     []*FolderProgress `json:"children,omitempty"`
}

// scanProgress returns the running scan's progress for a library, or nil.
func (m *IndexManager) scanProgress(libraryID string) *ScanProgress {
	m.progressMu.Lock()
	defer m.progressMu.Unlock()
	return m.progress[libraryID]
}

func (m *IndexManager) setScanProgress(libraryID string, p *ScanProgress) {
	m.progressMu.Lock()
	defer m.progressMu.Unlock()
	if p == nil {
		delete(m.progress, libraryID)
		return
	}
	m.progress[libraryID] = p
}

// FolderScanState says whether the running scan of a library still has files
// to record under folder that the index does not hold yet, so a folder view
// can say "waiting to be indexed" instead of showing a count that is only
// partial. indexed is the folder's current count in the index. It returns
// "" when the folder's count is already complete.
func (m *IndexManager) FolderScanState(libraryID, folder string, indexed int) (state string, total, scanned int) {
	p := m.scanProgress(libraryID)
	if p == nil {
		return "", 0, 0
	}
	total, scanned, ok := p.Under(folder)
	if !ok {
		// Still counting: only a folder with nothing indexed is in doubt.
		if indexed == 0 {
			return FolderWaiting, 0, 0
		}
		return "", 0, 0
	}
	// A rescan of a folder already in the index walks it too; nothing is
	// missing from its count then, so it is not reported.
	if scanned >= total || indexed >= total {
		return "", total, scanned
	}
	if scanned == 0 {
		return FolderWaiting, total, scanned
	}
	return FolderScanning, total, scanned
}

// Progress reports the library's indexing progress as a folder tree.
func (m *IndexManager) Progress(ctx context.Context, libraryID, root string) (*Progress, error) {
	db, release, err := acquireLibraryDB(root)
	if err != nil {
		return nil, err
	}
	defer release()

	out := &Progress{LibraryID: libraryID}
	q := jobs.NewQueue(db, m.logger)

	pending, failed, err := mediaJobsByDir(ctx, db)
	if err != nil {
		return nil, err
	}

	// Per-directory file counts: the running scan's, else the index's.
	files := map[string]int{}
	scanned := map[string]int{}
	sp := m.scanProgress(libraryID)
	counting := false
	if sp != nil {
		phase, current, startedAt, dirs := sp.snapshot()
		state := &ScanState{Phase: phase, StartedAt: startedAt, CurrentFolder: current}
		counting = phase == PhaseCounting
		for d, c := range dirs {
			files[d] = c.total
			scanned[d] = c.done
			state.FilesTotal += c.total
			state.FilesScanned += c.done
		}
		out.Scan = state
	}
	if sp == nil || counting {
		indexed, err := indexedByDir(ctx, db)
		if err != nil {
			return nil, err
		}
		for d, n := range indexed {
			files[d] = n
			if sp == nil {
				scanned[d] = n
			}
		}
	}
	if sp == nil {
		queued, err := q.HasActive(ctx, jobs.KindIndex)
		if err != nil {
			return nil, err
		}
		out.ScanQueued = queued
	}

	out.Root = buildTree(files, scanned, pending, failed, sp != nil)
	out.MediaPending = out.Root.MediaPending
	out.MediaFailed = out.Root.MediaFailed
	return out, nil
}

// indexedByDir counts the present files in the index per directory.
func indexedByDir(ctx context.Context, db *sql.DB) (map[string]int, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT rel_path FROM indexed_files WHERE status = 'present'`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]int{}
	for rows.Next() {
		var rel string
		if err := rows.Scan(&rel); err != nil {
			return nil, err
		}
		out[relDir(rel)]++
	}
	return out, rows.Err()
}

// mediaJobsByDir counts process_media jobs still to run, and those that
// failed for good, per directory of the file they are for.
func mediaJobsByDir(ctx context.Context, db *sql.DB) (pending, failed map[string]int, err error) {
	rows, err := db.QueryContext(ctx,
		`SELECT status, payload FROM index_jobs
		 WHERE kind = ? AND status IN ('queued', 'running', 'failed')`, jobs.KindProcessMedia)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = rows.Close() }()
	pending, failed = map[string]int{}, map[string]int{}
	for rows.Next() {
		var status, raw string
		if err := rows.Scan(&status, &raw); err != nil {
			return nil, nil, err
		}
		var payload struct {
			RelPath string `json:"rel_path"`
		}
		if json.Unmarshal([]byte(raw), &payload) != nil || payload.RelPath == "" {
			continue
		}
		if status == "failed" {
			failed[relDir(payload.RelPath)]++
		} else {
			pending[relDir(payload.RelPath)]++
		}
	}
	return pending, failed, rows.Err()
}

// buildTree assembles per-directory counts into a tree whose counts cover
// each folder's whole subtree, and gives every folder a status.
func buildTree(files, scanned, pending, failed map[string]int, scanning bool) *FolderProgress {
	nodes := map[string]*FolderProgress{"": {Path: "", Name: ""}}
	var ensure func(d string) *FolderProgress
	ensure = func(d string) *FolderProgress {
		if n, ok := nodes[d]; ok {
			return n
		}
		n := &FolderProgress{Path: d, Name: path.Base(d)}
		nodes[d] = n
		parent := ensure(relDir(d))
		parent.Children = append(parent.Children, n)
		return n
	}
	for _, m := range []map[string]int{files, scanned, pending, failed} {
		for d := range m {
			ensure(d)
		}
	}
	for d, n := range nodes {
		n.Files = files[d]
		n.Scanned = scanned[d]
		n.MediaPending = pending[d]
		n.MediaFailed = failed[d]
	}

	var sum func(n *FolderProgress)
	sum = func(n *FolderProgress) {
		sort.Slice(n.Children, func(i, j int) bool {
			return strings.ToLower(n.Children[i].Name) < strings.ToLower(n.Children[j].Name)
		})
		for _, c := range n.Children {
			sum(c)
			n.Files += c.Files
			n.Scanned += c.Scanned
			n.MediaPending += c.MediaPending
			n.MediaFailed += c.MediaFailed
		}
		switch {
		case scanning && n.Scanned == 0 && n.Files > 0:
			n.Status = FolderWaiting
		case scanning && n.Scanned < n.Files:
			n.Status = FolderScanning
		case n.MediaPending > 0:
			n.Status = FolderProcessing
		default:
			n.Status = FolderDone
		}
	}
	root := nodes[""]
	sum(root)
	return root
}
