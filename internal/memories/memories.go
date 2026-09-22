// Package memories manages long-form Markdown memories in a per-library
// SQLite database.
//
// Memories are app-level documents that live alongside the library so they are
// portable with it. Every save (including autosaves from the editor) appends a
// new row to memory_versions, giving the full edit history. Internal
// [[type:id]] references are parsed from the Markdown body on each save and
// stored in memory_refs so they can be queried and rendered.
package memories

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/fts"
	"github.com/Jishnu-Prasad888/Cairn/internal/markdown"
)

// ErrNotFound is returned when a memory does not exist.
var ErrNotFound = errors.New("memory not found")

// ErrVersionNotFound is returned when a memory version does not exist.
var ErrVersionNotFound = errors.New("memory version not found")

// ValidationError indicates the caller supplied an invalid memory
// (for example a blank title).
type ValidationError struct {
	msg string
}

func (e *ValidationError) Error() string { return e.msg }

// Memory is a single Markdown memory document.
type Memory struct {
	ID         string
	Title      string
	Body       string
	MemoryDate *time.Time
	Deleted    bool
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// MemoryVersion is one saved revision of a memory's title/body.
type MemoryVersion struct {
	MemoryID string
	Version  int
	Title    string
	Body     string
	SavedAt  time.Time
}

// CreateParams are the fields required to create a memory.
type CreateParams struct {
	Title      string
	Body       string
	MemoryDate *time.Time
}

// UpdateParams are the fields that can change on an update. A nil MemoryDate
// leaves the existing date unchanged.
type UpdateParams struct {
	Title      string
	Body       string
	MemoryDate *time.Time
	// ClearDate removes an existing memory date when true.
	ClearDate bool
}

// MemoryStore is the repository for memories in a per-library database.
type MemoryStore struct {
	db *sql.DB
}

// NewMemoryStore wraps a per-library database pool.
func NewMemoryStore(db *sql.DB) *MemoryStore {
	return &MemoryStore{db: db}
}

// Create inserts a new memory and records its first version. References are
// extracted from the body and stored in memory_refs.
func (s *MemoryStore) Create(ctx context.Context, p CreateParams) (*Memory, error) {
	if strings.TrimSpace(p.Title) == "" {
		return nil, &ValidationError{msg: "memory requires a title"}
	}
	id := newID()
	now := rfc3339(time.Now().UTC())

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin create memory: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	_, err = tx.ExecContext(ctx,
		`INSERT INTO memories (id, title, body, memory_date, deleted, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 0, ?, ?)`,
		id, p.Title, p.Body, optionalTime(p.MemoryDate), now, now)
	if err != nil {
		return nil, fmt.Errorf("insert memory: %w", err)
	}

	verID := newID()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO memory_versions (id, memory_id, version, title, body, saved_at)
		 VALUES (?, ?, 1, ?, ?, ?)`,
		verID, id, p.Title, p.Body, now); err != nil {
		return nil, fmt.Errorf("insert memory version: %w", err)
	}

	if err := s.replaceRefsTx(ctx, tx, id, p.Body); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit create memory: %w", err)
	}

	return &Memory{
		ID:         id,
		Title:      p.Title,
		Body:       p.Body,
		MemoryDate: p.MemoryDate,
		Deleted:    false,
		CreatedAt:  nowTime(now),
		UpdatedAt:  nowTime(now),
	}, nil
}

// Get returns a memory by ID. Deleted memories are returned with Deleted=true
// so callers can present a restore path.
func (s *MemoryStore) Get(ctx context.Context, id string) (*Memory, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, title, body, memory_date, deleted, created_at, updated_at
		 FROM memories WHERE id = ?`, id)
	return s.scanMemory(row)
}

// Update applies a new title/body to a memory, appends a new version, and
// rewrites extracted references, all in one transaction. It refuses to update
// deleted memories.
func (s *MemoryStore) Update(ctx context.Context, id string, p UpdateParams) (*Memory, error) {
	if strings.TrimSpace(p.Title) == "" {
		return nil, &ValidationError{msg: "memory requires a title"}
	}
	now := rfc3339(time.Now().UTC())

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin update memory: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var existing struct {
		Deleted int
		Date    sql.NullString
		Version int
		Title   string
		Body    string
		Created string
		Updated string
	}
	err = tx.QueryRowContext(ctx,
		`SELECT deleted, memory_date, created_at, updated_at, title, body FROM memories WHERE id = ?`,
		id).Scan(&existing.Deleted, &existing.Date, &existing.Created, &existing.Updated, &existing.Title, &existing.Body)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("read memory for update: %w", err)
	}
	if existing.Deleted != 0 {
		return nil, fmt.Errorf("memory is deleted")
	}

	var nextVersion int
	if err := tx.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(version), 0) + 1 FROM memory_versions WHERE memory_id = ?`, id).Scan(&nextVersion); err != nil {
		return nil, fmt.Errorf("compute next memory version: %w", err)
	}

	dateVal := existing.Date
	if p.ClearDate {
		dateVal = sql.NullString{}
	} else if p.MemoryDate != nil {
		dateVal = sql.NullString{String: rfc3339(*p.MemoryDate), Valid: true}
	}

	if _, err := tx.ExecContext(ctx,
		`UPDATE memories SET title = ?, body = ?, memory_date = ?, updated_at = ? WHERE id = ?`,
		p.Title, p.Body, dateVal, now, id); err != nil {
		return nil, fmt.Errorf("update memory: %w", err)
	}

	verID := newID()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO memory_versions (id, memory_id, version, title, body, saved_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		verID, id, nextVersion, p.Title, p.Body, now); err != nil {
		return nil, fmt.Errorf("insert memory version: %w", err)
	}

	if err := s.replaceRefsTx(ctx, tx, id, p.Body); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit update memory: %w", err)
	}

	return &Memory{
		ID:         id,
		Title:      p.Title,
		Body:       p.Body,
		MemoryDate: optionalDate(dateVal),
		Deleted:    false,
		CreatedAt:  parseOrNow(existing.Created),
		UpdatedAt:  nowTime(now),
	}, nil
}

// Delete soft-deletes a memory. Its versions and references are retained so
// the memory can be recovered later; List and Search exclude it.
func (s *MemoryStore) Delete(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE memories SET deleted = 1, updated_at = ? WHERE id = ?`,
		rfc3339(time.Now().UTC()), id)
	if err != nil {
		return fmt.Errorf("delete memory: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// Restore clears the soft-delete flag on a memory.
func (s *MemoryStore) Restore(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE memories SET deleted = 0, updated_at = ? WHERE id = ?`,
		rfc3339(time.Now().UTC()), id)
	if err != nil {
		return fmt.Errorf("restore memory: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// List returns non-deleted memories ordered by most recently updated first,
// with keyset pagination. The second return value is the cursor for the next
// page (empty when there are no further items).
func (s *MemoryStore) List(ctx context.Context, cursor string, limit int) ([]*Memory, string, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	query := `SELECT id, title, body, memory_date, deleted, created_at, updated_at
		FROM memories WHERE deleted = 0`
	args := []any{}
	if cursor != "" {
		updatedAt, id, ok := decodeCursor(cursor)
		if ok {
			query += ` AND (updated_at < ? OR (updated_at = ? AND id < ?))`
			args = append(args, updatedAt, updatedAt, id)
		}
	}
	query += ` ORDER BY updated_at DESC, id DESC LIMIT ?`
	args = append(args, limit+1)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("list memories: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []*Memory
	for rows.Next() {
		m, err := s.scanMemory(rows)
		if err != nil {
			return nil, "", err
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}

	next := ""
	if len(out) > limit {
		next = encodeCursor(out[limit-1])
		out = out[:limit]
	}
	return out, next, nil
}

// Search runs a full-text query over memory titles and bodies and returns
// matching non-deleted memories, most recently updated first, plus the cursor
// for the next page.
func (s *MemoryStore) Search(ctx context.Context, q, cursor string, limit int) ([]*Memory, string, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	expr, err := fts.BuildExpression(q)
	if err != nil {
		return nil, "", err
	}
	query := `
		SELECT m.id, m.title, m.body, m.memory_date, m.deleted, m.created_at, m.updated_at
		FROM memories m
		WHERE m.deleted = 0`
	args := []any{}
	if expr != "" {
		query = `
			SELECT m.id, m.title, m.body, m.memory_date, m.deleted, m.created_at, m.updated_at
			FROM fts_memories
			JOIN memories m ON fts_memories.memory_id = m.id
			WHERE fts_memories MATCH ? AND m.deleted = 0`
		args = append(args, expr)
	}
	if cursor != "" {
		updatedAt, id, ok := decodeCursor(cursor)
		if ok {
			query += ` AND (m.updated_at < ? OR (m.updated_at = ? AND m.id < ?))`
			args = append(args, updatedAt, updatedAt, id)
		}
	}
	query += ` ORDER BY m.updated_at DESC, m.id DESC LIMIT ?`
	args = append(args, limit+1)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("search memories: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []*Memory
	for rows.Next() {
		m, err := s.scanMemory(rows)
		if err != nil {
			return nil, "", err
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}

	next := ""
	if len(out) > limit {
		next = encodeCursor(out[limit-1])
		out = out[:limit]
	}
	return out, next, nil
}

// ListVersions returns the edit history of a memory, newest first.
func (s *MemoryStore) ListVersions(ctx context.Context, memoryID string) ([]*MemoryVersion, error) {
	if _, err := s.Get(ctx, memoryID); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT memory_id, version, title, body, saved_at
		 FROM memory_versions WHERE memory_id = ? ORDER BY version DESC`, memoryID)
	if err != nil {
		return nil, fmt.Errorf("list memory versions: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []*MemoryVersion
	for rows.Next() {
		var (
			v    MemoryVersion
			date string
		)
		if err := rows.Scan(&v.MemoryID, &v.Version, &v.Title, &v.Body, &date); err != nil {
			return nil, fmt.Errorf("scan memory version: %w", err)
		}
		if err := parseTime(date, &v.SavedAt); err != nil {
			return nil, err
		}
		out = append(out, &v)
	}
	return out, rows.Err()
}

// GetVersion returns a single historical version of a memory.
func (s *MemoryStore) GetVersion(ctx context.Context, memoryID string, version int) (*MemoryVersion, error) {
	var (
		v    MemoryVersion
		date string
	)
	err := s.db.QueryRowContext(ctx,
		`SELECT memory_id, version, title, body, saved_at
		 FROM memory_versions WHERE memory_id = ? AND version = ?`,
		memoryID, version).Scan(&v.MemoryID, &v.Version, &v.Title, &v.Body, &date)
	if err == sql.ErrNoRows {
		return nil, ErrVersionNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get memory version: %w", err)
	}
	if err := parseTime(date, &v.SavedAt); err != nil {
		return nil, err
	}
	return &v, nil
}

// ListRefs returns the internal references stored for a memory.
func (s *MemoryStore) ListRefs(ctx context.Context, memoryID string) ([]markdown.Reference, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT target_type, target_id FROM memory_refs WHERE memory_id = ? ORDER BY target_type, target_id`,
		memoryID)
	if err != nil {
		return nil, fmt.Errorf("list memory refs: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []markdown.Reference
	for rows.Next() {
		var (
			ref markdown.Reference
			typ string
		)
		if err := rows.Scan(&typ, &ref.ID); err != nil {
			return nil, err
		}
		ref.Type = markdown.RefType(typ)
		out = append(out, ref)
	}
	return out, rows.Err()
}

// replaceRefsTx deletes and re-inserts the extracted references for a memory
// from its current body, inside an existing transaction.
func (s *MemoryStore) replaceRefsTx(ctx context.Context, tx *sql.Tx, id, body string) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM memory_refs WHERE memory_id = ?`, id); err != nil {
		return fmt.Errorf("clear memory refs: %w", err)
	}
	refs := markdown.ParseReferences(body)
	if len(refs) == 0 {
		return nil
	}
	seen := make(map[[2]string]struct{}, len(refs))
	for _, r := range refs {
		key := [2]string{string(r.Type), r.ID}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO memory_refs (memory_id, target_type, target_id) VALUES (?, ?, ?)`,
			id, string(r.Type), r.ID); err != nil {
			return fmt.Errorf("insert memory ref: %w", err)
		}
	}
	return nil
}

// --- cursors ---

// encodeCursor flattens a (updatedAt, id) keyset value into an opaque string.
func encodeCursor(m *Memory) string {
	raw := updatedKey(m.UpdatedAt, m.ID)
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func updatedKey(t time.Time, id string) string {
	return rfc3339(t) + "\x01" + id
}

// decodeCursor reverses encodeCursor.
func decodeCursor(cursor string) (updatedAt, id string, ok bool) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return "", "", false
	}
	sep := strings.IndexByte(string(raw), '\x01')
	if sep <= 0 || sep == len(raw)-1 {
		return "", "", false
	}
	return string(raw[:sep]), string(raw[sep+1:]), true
}

// --- scanners & helpers ---

type rowScanner interface {
	Scan(dest ...any) error
}

func (s *MemoryStore) scanMemory(row rowScanner) (*Memory, error) {
	var (
		m          Memory
		date       sql.NullString
		deleted    int
		createdStr string
		updatedStr string
	)
	err := row.Scan(&m.ID, &m.Title, &m.Body, &date, &deleted, &createdStr, &updatedStr)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("scan memory: %w", err)
	}
	m.Deleted = deleted != 0
	m.MemoryDate = optionalDate(date)
	if err := parseTime(createdStr, &m.CreatedAt); err != nil {
		return nil, err
	}
	if err := parseTime(updatedStr, &m.UpdatedAt); err != nil {
		return nil, err
	}
	return &m, nil
}

func optionalDate(s sql.NullString) *time.Time {
	if !s.Valid || s.String == "" {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, s.String)
	if err != nil {
		return nil
	}
	return &t
}

func optionalTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return (*t).UTC().Format(time.RFC3339Nano)
}

func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("fallback-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
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

// nowTime converts an already-formatted RFC3339 string back to a time.Time.
// It falls back to time.Now() if the string is malformed.
func nowTime(s string) time.Time {
	var t time.Time
	if err := parseTime(s, &t); err != nil {
		return time.Now()
	}
	return t
}

func parseOrNow(s string) time.Time {
	var t time.Time
	if err := parseTime(s, &t); err != nil {
		return time.Now()
	}
	return t
}
