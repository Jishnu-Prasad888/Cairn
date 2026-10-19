package indexer

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/media"
)

// StateStore persists and queries indexed file records in the per-library
// SQLite database. All times are stored as RFC3339Nano UTC strings.
type StateStore struct {
	db *sql.DB
}

// NewStateStore wraps a per-library database connection.
func NewStateStore(db *sql.DB) *StateStore {
	return &StateStore{db: db}
}

// upsertQuery inserts or refreshes one indexed file. media_type is derived
// from the path here so a file is classified the moment it is indexed.
const upsertQuery = `
	INSERT INTO indexed_files
		(id, rel_path, size_bytes, mod_time, content_hash, media_type, status,
		 first_seen_at, last_seen_at, indexed_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(rel_path) DO UPDATE SET
		size_bytes    = excluded.size_bytes,
		mod_time      = excluded.mod_time,
		content_hash  = excluded.content_hash,
		media_type    = excluded.media_type,
		status        = excluded.status,
		last_seen_at  = excluded.last_seen_at,
		indexed_at    = excluded.indexed_at`

// updatePathQuery moves an existing record to a new path; the extension may
// have changed, so media_type is re-derived.
const updatePathQuery = `
	UPDATE indexed_files SET rel_path = ?, media_type = ?, last_seen_at = ?, indexed_at = ?,
	                         status = 'present'
	WHERE id = ?`

func upsertArgs(f *IndexedFile) []any {
	return []any{
		f.ID, f.RelPath, f.SizeBytes, rfc3339(f.ModTime),
		nullString(f.ContentHash), string(media.DetectMediaType(f.RelPath)), string(f.Status),
		rfc3339(f.FirstSeenAt), rfc3339(f.LastSeenAt), rfc3339(f.IndexedAt),
	}
}

func updatePathArgs(id, newRelPath string, now time.Time) []any {
	return []any{newRelPath, string(media.DetectMediaType(newRelPath)), rfc3339(now), rfc3339(now), id}
}

// Upsert inserts or updates an indexed file record. It uses INSERT OR REPLACE
// so that a re-scan that finds the same file simply refreshes last_seen_at and
// status without changing first_seen_at.
func (s *StateStore) Upsert(ctx context.Context, f *IndexedFile) error {
	if _, err := s.db.ExecContext(ctx, upsertQuery, upsertArgs(f)...); err != nil {
		return fmt.Errorf("upsert indexed file %q: %w", f.RelPath, err)
	}
	return nil
}

// Batch limits: a batch is written once it holds batchMaxOps writes or its
// oldest write has waited batchMaxAge, whichever comes first. The age bound
// keeps a slow walk (hashing large files) from holding writes back for long.
const (
	batchMaxOps = 500
	batchMaxAge = 250 * time.Millisecond
)

// WriteBatch buffers index writes and applies them in one transaction.
//
// A scan used to commit every file on its own, so a rescan of 100k unchanged
// files was 100k transactions. Writes are buffered rather than run inside an
// open transaction so the database is only locked while a batch is written,
// never while the scanner is walking or hashing.
type WriteBatch struct {
	store *StateStore
	ops   []batchOp
	since time.Time
}

type batchOp struct {
	query string
	args  []any
	desc  string
}

// NewBatch returns an empty WriteBatch for this store.
func (s *StateStore) NewBatch() *WriteBatch {
	return &WriteBatch{store: s}
}

func (b *WriteBatch) add(op batchOp) {
	if len(b.ops) == 0 {
		b.since = time.Now()
	}
	b.ops = append(b.ops, op)
}

// Upsert queues an Upsert of f as it is now.
func (b *WriteBatch) Upsert(f *IndexedFile) {
	b.add(batchOp{query: upsertQuery, args: upsertArgs(f), desc: "upsert indexed file " + f.RelPath})
}

// UpdatePath queues an UpdatePath.
func (b *WriteBatch) UpdatePath(id, newRelPath string, now time.Time) {
	b.add(batchOp{query: updatePathQuery, args: updatePathArgs(id, newRelPath, now), desc: "update path for " + id})
}

// Due reports whether the batch should be flushed now.
func (b *WriteBatch) Due() bool {
	return len(b.ops) >= batchMaxOps || (len(b.ops) > 0 && time.Since(b.since) >= batchMaxAge)
}

// Flush writes every queued operation and empties the batch. They go in one
// transaction; if that fails, each is retried on its own so one bad write
// (say, a move onto a path a deleted record still holds) costs that one file
// rather than the batch. The errors of writes that still failed are returned.
func (b *WriteBatch) Flush(ctx context.Context) []error {
	if len(b.ops) == 0 {
		return nil
	}
	defer func() { b.ops = b.ops[:0] }()
	if b.flushTx(ctx) == nil {
		return nil
	}
	var errs []error
	for _, op := range b.ops {
		if _, err := b.store.db.ExecContext(ctx, op.query, op.args...); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", op.desc, err))
		}
	}
	return errs
}

func (b *WriteBatch) flushTx(ctx context.Context) error {
	tx, err := b.store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	stmts := map[string]*sql.Stmt{}
	defer func() {
		for _, st := range stmts {
			_ = st.Close()
		}
	}()
	for _, op := range b.ops {
		st, ok := stmts[op.query]
		if !ok {
			if st, err = tx.PrepareContext(ctx, op.query); err != nil {
				return err
			}
			stmts[op.query] = st
		}
		if _, err := st.ExecContext(ctx, op.args...); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// GetByPath returns the indexed file record for the given relative path, or
// (nil, nil) when not found.
func (s *StateStore) GetByPath(ctx context.Context, relPath string) (*IndexedFile, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, rel_path, size_bytes, mod_time, content_hash, status,
		        first_seen_at, last_seen_at, indexed_at
		 FROM indexed_files WHERE rel_path = ?`, relPath)
	return scanFile(row)
}

// GetByHash returns all indexed file records matching the given content hash.
// Used for move detection: when a new path has the same hash as a missing
// entry, the file has moved rather than been deleted and re-created.
func (s *StateStore) GetByHash(ctx context.Context, hash string) ([]*IndexedFile, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, rel_path, size_bytes, mod_time, content_hash, status,
		        first_seen_at, last_seen_at, indexed_at
		 FROM indexed_files WHERE content_hash = ?`, hash)
	if err != nil {
		return nil, fmt.Errorf("query by hash: %w", err)
	}
	defer func() { _ = rows.Close() }()
	return scanFiles(rows)
}

// AllPresent returns all files currently marked as present or missing. This is
// the set the scanner reconciles at the end of each walk.
func (s *StateStore) AllPresent(ctx context.Context) ([]*IndexedFile, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, rel_path, size_bytes, mod_time, content_hash, status,
		        first_seen_at, last_seen_at, indexed_at
		 FROM indexed_files WHERE status IN ('present', 'missing')`)
	if err != nil {
		return nil, fmt.Errorf("query all present files: %w", err)
	}
	defer func() { _ = rows.Close() }()
	return scanFiles(rows)
}

// MarkMissing marks indexed files that were not observed during a scan as
// missing. seenIDs is the set of file IDs touched in this scan run.
func (s *StateStore) MarkMissing(ctx context.Context, seenIDs map[string]struct{}, now time.Time) (int, error) {
	// Fetch all present files and mark the ones not in seenIDs.
	files, err := s.AllPresent(ctx)
	if err != nil {
		return 0, err
	}
	batch := s.NewBatch()
	var count int
	for _, f := range files {
		if _, seen := seenIDs[f.ID]; seen {
			continue
		}
		if f.Status == StatusMissing {
			continue // already missing; leave last_seen_at intact
		}
		f.Status = StatusMissing
		f.LastSeenAt = now
		f.IndexedAt = now
		batch.Upsert(f)
		count++
		if len(batch.ops) >= batchMaxOps {
			if errs := batch.Flush(ctx); len(errs) > 0 {
				return 0, errs[0]
			}
		}
	}
	if errs := batch.Flush(ctx); len(errs) > 0 {
		return 0, errs[0]
	}
	return count, nil
}

// UpdatePath updates the relative path of an existing record. Used when a
// move is detected: the old entry's path is replaced with the new location.
func (s *StateStore) UpdatePath(ctx context.Context, id, newRelPath string, now time.Time) error {
	if _, err := s.db.ExecContext(ctx, updatePathQuery, updatePathArgs(id, newRelPath, now)...); err != nil {
		return fmt.Errorf("update path for %s: %w", id, err)
	}
	return nil
}

// Counts returns a summary of the current index state.
func (s *StateStore) Counts(ctx context.Context) (present, missing, deleted int, err error) {
	rows, queryErr := s.db.QueryContext(ctx,
		`SELECT status, COUNT(*) FROM indexed_files GROUP BY status`)
	if queryErr != nil {
		return 0, 0, 0, fmt.Errorf("count indexed files: %w", queryErr)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var status string
		var n int
		if scanErr := rows.Scan(&status, &n); scanErr != nil {
			return 0, 0, 0, scanErr
		}
		switch Status(status) {
		case StatusPresent:
			present = n
		case StatusMissing:
			missing = n
		case StatusDeleted:
			deleted = n
		}
	}
	return present, missing, deleted, rows.Err()
}

// --- row scanning helpers ---

type rowScanner interface {
	Scan(dest ...any) error
}

func scanFile(row rowScanner) (*IndexedFile, error) {
	var (
		f           IndexedFile
		modTimeStr  string
		contentHash sql.NullString
		firstStr    string
		lastStr     string
		indexedStr  string
		status      string
	)
	err := row.Scan(&f.ID, &f.RelPath, &f.SizeBytes, &modTimeStr, &contentHash,
		&status, &firstStr, &lastStr, &indexedStr)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("scan indexed file: %w", err)
	}
	f.Status = Status(status)
	f.ContentHash = contentHash.String
	if err := parseTime(modTimeStr, &f.ModTime); err != nil {
		return nil, err
	}
	if err := parseTime(firstStr, &f.FirstSeenAt); err != nil {
		return nil, err
	}
	if err := parseTime(lastStr, &f.LastSeenAt); err != nil {
		return nil, err
	}
	if err := parseTime(indexedStr, &f.IndexedAt); err != nil {
		return nil, err
	}
	return &f, nil
}

func scanFiles(rows *sql.Rows) ([]*IndexedFile, error) {
	var out []*IndexedFile
	for rows.Next() {
		f, err := scanFile(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
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

func nullString(s string) any {
	if s == "" {
		return nil
	}
	return s
}
