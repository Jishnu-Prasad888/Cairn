// Package search provides full-text search over indexed files in a per-library
// SQLite database using the FTS5 virtual table.
//
// The FTS5 table (fts_files) indexes rel_path. The default unicode61 tokenizer
// splits on path separators and punctuation, so searching "beach" will match
// "holiday/beach.jpg". Triggers on indexed_files keep fts_files in sync.
package search

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/media"
)

// SearchQuery specifies the parameters for a full-text file search.
type SearchQuery struct {
	// Text is the search expression. Empty means match all present files.
	Text string

	// Type restricts results to a specific media type. Empty means all.
	Type media.MediaType

	// FolderPath restricts results to files under this folder (prefix match).
	// Empty means search the entire library.
	FolderPath string

	// DateFrom and DateTo restrict results by indexed_files.mod_time.
	// Zero values are ignored.
	DateFrom time.Time
	DateTo   time.Time

	// Cursor is the last file_id seen (for cursor-based pagination).
	// Used only in the non-FTS path (Text == "").
	Cursor string

	// Limit is the maximum number of results to return. Defaults to 50.
	Limit int
}

// Defaults fills in zero values with sensible defaults.
func (q *SearchQuery) Defaults() {
	if q.Limit <= 0 {
		q.Limit = 50
	}
	if q.Limit > 200 {
		q.Limit = 200
	}
}

// SearchResult is a single file matching the search query.
type SearchResult struct {
	File *media.File
}

// SearchPage is a paginated list of search results.
type SearchPage struct {
	Results    []*SearchResult
	NextCursor string
	Total      int
}

// SearchStore runs FTS5 queries against a per-library database.
type SearchStore struct {
	db        *sql.DB
	libraryID string
}

// NewSearchStore wraps a per-library database pool.
func NewSearchStore(db *sql.DB, libraryID string) *SearchStore {
	return &SearchStore{db: db, libraryID: libraryID}
}

// Search runs a full-text search and returns a page of results.
func (s *SearchStore) Search(ctx context.Context, q SearchQuery) (*SearchPage, error) {
	q.Defaults()

	var (
		queryStr  string
		queryArgs []any
	)

	// Extra filters applied after the primary WHERE clause.
	extraConds, extraArgs := buildExtraFilters(q)

	if q.Text != "" {
		ftsExpr := sanitizeFTSQuery(q.Text)
		whereClause := "WHERE fts_files MATCH ? AND f.status = 'present'"
		if len(extraConds) > 0 {
			whereClause += " AND " + strings.Join(extraConds, " AND ")
		}
		queryStr = fmt.Sprintf(`
			SELECT f.id, f.rel_path, f.size_bytes, f.mod_time, f.content_hash,
			       f.status, f.first_seen_at, f.last_seen_at
			FROM fts_files
			JOIN indexed_files f ON fts_files.file_id = f.id
			%s
			ORDER BY rank, f.rel_path
			LIMIT ?`, whereClause)
		queryArgs = append([]any{ftsExpr}, extraArgs...)
		queryArgs = append(queryArgs, q.Limit+1)
	} else {
		whereClause := "WHERE f.status = 'present'"
		if len(extraConds) > 0 {
			whereClause += " AND " + strings.Join(extraConds, " AND ")
		}
		// Add cursor for non-FTS pagination.
		if q.Cursor != "" {
			whereClause += " AND f.id > ?"
			extraArgs = append(extraArgs, q.Cursor)
		}
		queryStr = fmt.Sprintf(`
			SELECT f.id, f.rel_path, f.size_bytes, f.mod_time, f.content_hash,
			       f.status, f.first_seen_at, f.last_seen_at
			FROM indexed_files f
			%s
			ORDER BY f.id
			LIMIT ?`, whereClause)
		queryArgs = append(extraArgs, q.Limit+1)
	}

	rows, err := s.db.QueryContext(ctx, queryStr, queryArgs...)
	if err != nil {
		return nil, fmt.Errorf("search query: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var results []*SearchResult
	for rows.Next() {
		f, err := scanSearchFile(rows, s.libraryID)
		if err != nil {
			return nil, err
		}
		results = append(results, &SearchResult{File: f})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	page := &SearchPage{}
	if len(results) > q.Limit {
		page.NextCursor = results[q.Limit-1].File.ID
		results = results[:q.Limit]
	}
	page.Results = results

	// Approximate total count (best-effort; ignored on error).
	total, err := s.countSearch(ctx, q)
	if err == nil {
		page.Total = total
	}
	return page, nil
}

// buildExtraFilters returns WHERE fragment conditions and bind args for the
// non-status, non-FTS filters (folder, type, date range).
func buildExtraFilters(q SearchQuery) ([]string, []any) {
	var conditions []string
	var args []any

	if q.FolderPath != "" && q.FolderPath != "." {
		fp := filepath.ToSlash(q.FolderPath)
		conditions = append(conditions, "f.rel_path LIKE ?")
		args = append(args, fp+"/%")
	}
	if q.Type != "" {
		conditions = append(conditions, "f.id IN (SELECT file_id FROM media_metadata WHERE media_type = ?)")
		args = append(args, string(q.Type))
	}
	if !q.DateFrom.IsZero() {
		conditions = append(conditions, "f.mod_time >= ?")
		args = append(args, q.DateFrom.UTC().Format(time.RFC3339Nano))
	}
	if !q.DateTo.IsZero() {
		conditions = append(conditions, "f.mod_time <= ?")
		args = append(args, q.DateTo.UTC().Format(time.RFC3339Nano))
	}
	return conditions, args
}

// countSearch returns an approximate total count for the given query (no cursor).
func (s *SearchStore) countSearch(ctx context.Context, q SearchQuery) (int, error) {
	extraConds, extraArgs := buildExtraFilters(q)

	var queryStr string
	var queryArgs []any

	if q.Text != "" {
		ftsExpr := sanitizeFTSQuery(q.Text)
		whereClause := "WHERE fts_files MATCH ? AND f.status = 'present'"
		if len(extraConds) > 0 {
			whereClause += " AND " + strings.Join(extraConds, " AND ")
		}
		queryStr = fmt.Sprintf(`
			SELECT COUNT(*)
			FROM fts_files
			JOIN indexed_files f ON fts_files.file_id = f.id
			%s`, whereClause)
		queryArgs = append([]any{ftsExpr}, extraArgs...)
	} else {
		whereClause := "WHERE f.status = 'present'"
		if len(extraConds) > 0 {
			whereClause += " AND " + strings.Join(extraConds, " AND ")
		}
		queryStr = fmt.Sprintf(`SELECT COUNT(*) FROM indexed_files f %s`, whereClause)
		queryArgs = extraArgs
	}

	var n int
	err := s.db.QueryRowContext(ctx, queryStr, queryArgs...).Scan(&n)
	return n, err
}

// sanitizeFTSQuery converts a raw user query into a safe FTS5 expression.
// Each whitespace-separated word is quoted and suffixed with * for prefix
// matching. Special FTS5 characters that could cause parse errors are stripped.
func sanitizeFTSQuery(raw string) string {
	replacer := strings.NewReplacer(
		`*`, ``,
		`(`, ``,
		`)`, ``,
		`^`, ``,
		`-`, ` `,
		`+`, ` `,
		`:`, ` `,
	)
	clean := strings.TrimSpace(replacer.Replace(raw))
	if clean == "" {
		return `""`
	}
	words := strings.Fields(clean)
	quoted := make([]string, 0, len(words))
	for _, w := range words {
		// Escape internal double-quotes by doubling them.
		w = strings.ReplaceAll(w, `"`, `""`)
		quoted = append(quoted, `"`+w+`"*`)
	}
	return strings.Join(quoted, " ")
}

// --- row scanner ---

type rowScanner interface {
	Scan(dest ...any) error
}

func scanSearchFile(row rowScanner, libraryID string) (*media.File, error) {
	var (
		f        media.File
		modStr   string
		firstStr string
		lastStr  string
		hash     sql.NullString
		status   string
	)
	err := row.Scan(&f.ID, &f.RelPath, &f.SizeBytes, &modStr, &hash, &status, &firstStr, &lastStr)
	if err != nil {
		return nil, fmt.Errorf("scan search file: %w", err)
	}
	f.LibraryID = libraryID
	f.ContentHash = hash.String
	f.Status = media.FileStatus(status)
	f.Name = filepath.Base(f.RelPath)
	f.FolderPath = filepath.ToSlash(filepath.Dir(f.RelPath))
	if f.FolderPath == "." {
		f.FolderPath = ""
	}
	f.MediaType = media.DetectMediaType(f.RelPath)
	f.MIMEType = media.DetectMIME(f.RelPath)
	if err := parseTime(modStr, &f.ModTime); err != nil {
		return nil, err
	}
	if err := parseTime(firstStr, &f.FirstSeenAt); err != nil {
		return nil, err
	}
	if err := parseTime(lastStr, &f.LastSeenAt); err != nil {
		return nil, err
	}
	return &f, nil
}

func parseTime(s string, out *time.Time) error {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return fmt.Errorf("parse time %q: %w", s, err)
	}
	*out = t
	return nil
}
