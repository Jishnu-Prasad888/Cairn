package librarydb

import (
	"database/sql"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// sharedIdleTTL is how long a shared pool stays open after its last user
// releases it. Long enough that a page of thumbnails, or a person clicking
// around, reuses one pool; short enough that an idle library does not keep
// its database open (on Windows an open file cannot be moved or deleted,
// and a removable drive should be safe to eject soon after use).
var sharedIdleTTL = 30 * time.Second

// sharedMaxConns bounds the connections a shared pool may hold. SQLite in WAL
// mode serves readers in parallel, so a grid of thumbnails need not queue
// behind one connection; writers still serialize on the database lock.
const sharedMaxConns = 4

type sharedPool struct {
	db      *sql.DB
	info    os.FileInfo // identity of library.db when the pool was opened
	refs    int
	retired bool // dropped from the cache; close when the last ref goes
	idle    *time.Timer
}

var (
	sharedMu    sync.Mutex
	sharedPools = map[string]*sharedPool{}
)

// Acquire returns a migrated connection pool for the library database in
// cairnDir that is shared with every other caller of Acquire for the same
// library, and a release func the caller must call exactly once when done.
//
// The caller must not Close the returned pool. Opening a SQLite database
// costs a file open, pragma setup and a schema parse, which used to be paid
// by every API request (one per thumbnail in a grid); a shared pool pays it
// once. The pool is closed after sharedIdleTTL without users, and is
// replaced when library.db is no longer the file it was opened on.
func Acquire(cairnDir string) (*sql.DB, func(), error) {
	path := filepath.Join(cairnDir, dbFileName)
	if db, release, ok := acquireCached(path); ok {
		return db, release, nil
	}

	// Open outside the lock: a slow or sleeping drive behind one library
	// must not hold up requests to every other library.
	db, err := Open(cairnDir)
	if err != nil {
		return nil, nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		_ = db.Close()
		return nil, nil, err
	}
	db.SetMaxOpenConns(sharedMaxConns)
	db.SetMaxIdleConns(sharedMaxConns)
	db.SetConnMaxIdleTime(sharedIdleTTL)

	sharedMu.Lock()
	defer sharedMu.Unlock()
	if p, ok := sharedPools[path]; ok && !p.retired && os.SameFile(p.info, info) {
		// Another request opened the same library meanwhile; use theirs.
		_ = db.Close()
		p.refs++
		return p.db, releaseFunc(path, p), nil
	} else if ok {
		retireLocked(path, p)
	}
	p := &sharedPool{db: db, info: info, refs: 1}
	sharedPools[path] = p
	return db, releaseFunc(path, p), nil
}

// acquireCached hands out the cached pool for path when library.db is still
// the file it was opened on, retiring it otherwise.
func acquireCached(path string) (*sql.DB, func(), bool) {
	info, statErr := os.Stat(path)
	sharedMu.Lock()
	defer sharedMu.Unlock()
	p, ok := sharedPools[path]
	if !ok {
		return nil, nil, false
	}
	if statErr != nil || !os.SameFile(p.info, info) {
		// The file went away or was replaced: stop handing this pool out.
		retireLocked(path, p)
		return nil, nil, false
	}
	p.refs++
	if p.idle != nil {
		p.idle.Stop()
		p.idle = nil
	}
	return p.db, releaseFunc(path, p), true
}

func releaseFunc(path string, p *sharedPool) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			sharedMu.Lock()
			defer sharedMu.Unlock()
			p.refs--
			if p.refs > 0 {
				return
			}
			if p.retired {
				_ = p.db.Close()
				return
			}
			p.idle = time.AfterFunc(sharedIdleTTL, func() {
				sharedMu.Lock()
				defer sharedMu.Unlock()
				if p.refs == 0 && sharedPools[path] == p {
					retireLocked(path, p)
				}
			})
		})
	}
}

// retireLocked removes p from the cache and closes it once unused. sharedMu
// must be held.
func retireLocked(path string, p *sharedPool) {
	if sharedPools[path] == p {
		delete(sharedPools, path)
	}
	p.retired = true
	if p.idle != nil {
		p.idle.Stop()
		p.idle = nil
	}
	if p.refs == 0 {
		_ = p.db.Close()
	}
}

// CloseShared closes every idle shared pool and marks the busy ones to close
// when released. Called on shutdown so WAL files are checkpointed cleanly.
func CloseShared() {
	sharedMu.Lock()
	defer sharedMu.Unlock()
	for path, p := range sharedPools {
		retireLocked(path, p)
	}
}
