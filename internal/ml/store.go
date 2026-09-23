package ml

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// SignatureRecord is one stored similarity signature for a file.
type SignatureRecord struct {
	FileID    string
	Provider  string
	Version   int
	Signature uint64
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Store persists similarity signatures in the per-library database
// (ml_signatures table). It is derived data: nothing here is authoritative
// and the whole table may be purged and regenerated.
type Store struct {
	db *sql.DB
}

// NewStore wraps a per-library database pool.
func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

// Upsert writes a signature for a file, updating the row when it already
// exists. Signatures are written per-file so a cancelled pass still makes
// progress.
func (s *Store) Upsert(ctx context.Context, rec SignatureRecord) error {
	now := rfc3339(time.Now().UTC())
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ml_signatures (file_id, provider, version, signature, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(file_id) DO UPDATE SET
			provider   = excluded.provider,
			version    = excluded.version,
			signature  = excluded.signature,
			updated_at = excluded.updated_at`,
		rec.FileID, rec.Provider, rec.Version,
		int64(rec.Signature), now, now)
	if err != nil {
		return fmt.Errorf("upsert signature: %w", err)
	}
	return nil
}

// Get returns the signature for a file, or nil when not present.
func (s *Store) Get(ctx context.Context, fileID string) (*SignatureRecord, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT file_id, provider, version, signature, created_at, updated_at
		FROM ml_signatures WHERE file_id = ?`, fileID)
	return s.scanRecord(row)
}

// UnsignedFile is one file missing a signature plus its relative path.
type UnsignedFile struct {
	FileID  string
	RelPath string
}

// IDsWithoutSignature returns present files that do not yet have a signature
// from the given provider version, with their relative paths.
func (s *Store) IDsWithoutSignature(ctx context.Context, provider string, version int) ([]UnsignedFile, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT f.id, f.rel_path
		FROM indexed_files f
		WHERE f.status = 'present'
		  AND NOT EXISTS (
		      SELECT 1 FROM ml_signatures m
		      WHERE m.file_id = f.id AND m.provider = ? AND m.version = ?
		  )`, provider, version)
	if err != nil {
		return nil, fmt.Errorf("list files without signature: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []UnsignedFile
	for rows.Next() {
		var u UnsignedFile
		if err := rows.Scan(&u.FileID, &u.RelPath); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// RelPath returns the stored relative path for a file id, or "" when missing.
func (s *Store) RelPath(ctx context.Context, fileID string) (string, error) {
	var rel string
	err := s.db.QueryRowContext(ctx,
		`SELECT rel_path FROM indexed_files WHERE id = ?`, fileID).Scan(&rel)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", nil
		}
		return "", fmt.Errorf("lookup rel path: %w", err)
	}
	return rel, nil
}

// Similar returns up to limit stored signatures, ordered by Hamming distance
// to query (closest first), excluding the query file. Similarity is normalized
// (64 - distance) / 64. It joins indexed_files so only present files are
// candidates.
func (s *Store) Similar(ctx context.Context, query uint64, limit int, excludeID string) ([]SimilarHit, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT m.file_id, m.signature
		FROM ml_signatures m
		JOIN indexed_files f ON f.id = m.file_id
		WHERE f.status = 'present' AND m.file_id != ?`,
		excludeID)
	if err != nil {
		return nil, fmt.Errorf("query similar files: %w", err)
	}
	defer func() { _ = rows.Close() }()

	hits := make([]candidate, 0, 64)
	for rows.Next() {
		var id string
		var sig int64
		if err := rows.Scan(&id, &sig); err != nil {
			return nil, err
		}
		d := popcount(uint64(sig) ^ query)
		hits = append(hits, candidate{id: id, distance: d})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return topN(hits, limit), nil
}

// Count returns the number of stored signatures.
func (s *Store) Count(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM ml_signatures`).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count signatures: %w", err)
	}
	return n, nil
}

// Purge deletes every derived signature. Originals are never touched.
func (s *Store) Purge(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM ml_signatures`); err != nil {
		return fmt.Errorf("purge signatures: %w", err)
	}
	return nil
}

func (s *Store) scanRecord(row rowScanner) (*SignatureRecord, error) {
	var (
		rec        SignatureRecord
		createdStr string
		updatedStr string
		sig        int64
	)
	err := row.Scan(&rec.FileID, &rec.Provider, &rec.Version, &sig, &createdStr, &updatedStr)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("scan signature: %w", err)
	}
	rec.Signature = uint64(sig)
	if err := parseTime(createdStr, &rec.CreatedAt); err != nil {
		return nil, err
	}
	if err := parseTime(updatedStr, &rec.UpdatedAt); err != nil {
		return nil, err
	}
	return &rec, nil
}

// SimilarHit is one similar file result.
type SimilarHit struct {
	FileID     string
	Distance   int
	Similarity float64
}

type candidate struct {
	id       string
	distance int
}

type rowScanner interface {
	Scan(dest ...any) error
}

// topN keeps the first limit candidates by distance ascending. For a
// personal library a simple insertion sort of a bounded slice is cheaper than
// a heap. Similarity is derived here, not persisted.
func topN(in []candidate, limit int) []SimilarHit {
	// Selection sort of the smallest limit distances.
	for i := 0; i < len(in)-1; i++ {
		best := i
		for j := i + 1; j < len(in); j++ {
			if in[j].distance < in[best].distance {
				best = j
			}
		}
		in[i], in[best] = in[best], in[i]
	}
	if limit > 0 && len(in) > limit {
		in = in[:limit]
	}
	out := make([]SimilarHit, 0, len(in))
	for _, c := range in {
		out = append(out, SimilarHit{
			FileID:     c.id,
			Distance:   c.distance,
			Similarity: float64(64-c.distance) / 64,
		})
	}
	return out
}

func popcount(x uint64) int {
	n := 0
	for x != 0 {
		x &= x - 1
		n++
	}
	return n
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
