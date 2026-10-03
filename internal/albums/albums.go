// Package albums manages named file collections (albums) in a per-library
// SQLite database. Albums group files without moving them on disk.
package albums

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Jishnu-Prasad888/Cairn/internal/media"
)

// ErrNotFound is returned when an album does not exist.
var ErrNotFound = errors.New("album not found")

// ErrFileNotInAlbum is returned when trying to remove a file that is not in the album.
var ErrFileNotInAlbum = errors.New("file is not in album")

// ErrEmptyName is returned when an album would be left without a name.
var ErrEmptyName = errors.New("album name must not be empty")

// Album represents a named collection of files.
type Album struct {
	ID          string
	Name        string
	Description string
	CoverFileID string
	CreatedAt   time.Time
	UpdatedAt   time.Time

	// FileCount is the number of files in the album.
	FileCount int
	// PreviewFileID is the file that represents the album in a grid: the
	// chosen cover when there is one, otherwise the first photo in album
	// order, otherwise the first file. Empty for an empty album.
	PreviewFileID string
}

// albumColumns selects an album row together with its file count and the
// file that previews it, so a list of albums needs one query rather than one
// per album.
const albumColumns = `a.id, a.name, a.description, a.cover_file_id, a.created_at, a.updated_at,
	(SELECT COUNT(*) FROM album_files af WHERE af.album_id = a.id),
	COALESCE(a.cover_file_id, (
		SELECT af.file_id FROM album_files af
		JOIN indexed_files f ON f.id = af.file_id
		WHERE af.album_id = a.id AND f.status = 'present'
		ORDER BY (f.media_type = 'photo') DESC, af.position
		LIMIT 1
	))`

// AlbumStore is the repository for albums in a per-library database.
type AlbumStore struct {
	db        *sql.DB
	libraryID string
}

// NewAlbumStore wraps a per-library database pool.
func NewAlbumStore(db *sql.DB, libraryID string) *AlbumStore {
	return &AlbumStore{db: db, libraryID: libraryID}
}

// Create creates a new album.
func (s *AlbumStore) Create(ctx context.Context, name, description string) (*Album, error) {
	if name == "" {
		return nil, ErrEmptyName
	}
	id := newID()
	now := rfc3339(time.Now().UTC())
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO albums (id, name, description, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
		id, name, nullStr(description), now, now)
	if err != nil {
		return nil, fmt.Errorf("create album: %w", err)
	}
	return s.GetByID(ctx, id)
}

// GetByID returns an album by its ID.
func (s *AlbumStore) GetByID(ctx context.Context, id string) (*Album, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT `+albumColumns+` FROM albums a WHERE a.id = ?`, id)
	return s.scanAlbum(row)
}

// List returns all albums ordered by name.
func (s *AlbumStore) List(ctx context.Context) ([]*Album, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+albumColumns+` FROM albums a ORDER BY a.name COLLATE NOCASE`)
	if err != nil {
		return nil, fmt.Errorf("list albums: %w", err)
	}
	defer func() { _ = rows.Close() }()
	return s.scanAlbums(rows)
}

// AlbumUpdate is a partial change to an album. A nil field is left alone.
type AlbumUpdate struct {
	Name        *string
	Description *string
	// CoverFileID sets the cover; an empty string clears it, so the album is
	// previewed by its first photo again.
	CoverFileID *string
}

// Update renames an album, changes its description, or sets its cover. The
// cover must be a file already in the album.
func (s *AlbumStore) Update(ctx context.Context, id string, u AlbumUpdate) (*Album, error) {
	if _, err := s.GetByID(ctx, id); err != nil {
		return nil, err
	}
	sets := []string{}
	args := []any{}
	if u.Name != nil {
		if *u.Name == "" {
			return nil, ErrEmptyName
		}
		sets = append(sets, "name = ?")
		args = append(args, *u.Name)
	}
	if u.Description != nil {
		sets = append(sets, "description = ?")
		args = append(args, nullStr(*u.Description))
	}
	if u.CoverFileID != nil {
		if *u.CoverFileID != "" {
			var n int
			if err := s.db.QueryRowContext(ctx,
				`SELECT COUNT(*) FROM album_files WHERE album_id = ? AND file_id = ?`,
				id, *u.CoverFileID).Scan(&n); err != nil {
				return nil, fmt.Errorf("check album cover: %w", err)
			}
			if n == 0 {
				return nil, ErrFileNotInAlbum
			}
		}
		sets = append(sets, "cover_file_id = ?")
		args = append(args, nullStr(*u.CoverFileID))
	}
	if len(sets) > 0 {
		sets = append(sets, "updated_at = ?")
		args = append(args, rfc3339(time.Now().UTC()), id)
		if _, err := s.db.ExecContext(ctx,
			`UPDATE albums SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...); err != nil {
			return nil, fmt.Errorf("update album: %w", err)
		}
	}
	return s.GetByID(ctx, id)
}

// Delete removes an album and all its file associations.
func (s *AlbumStore) Delete(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM albums WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete album: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// AddFile adds a file to an album. No-op if already present.
func (s *AlbumStore) AddFile(ctx context.Context, albumID, fileID string) error {
	// Determine next position.
	var maxPos int
	_ = s.db.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(position), -1) FROM album_files WHERE album_id = ?`, albumID).Scan(&maxPos)

	now := rfc3339(time.Now().UTC())
	_, err := s.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO album_files (album_id, file_id, position, added_at)
		 VALUES (?, ?, ?, ?)`,
		albumID, fileID, maxPos+1, now)
	if err != nil {
		return fmt.Errorf("add file to album: %w", err)
	}
	return s.touchUpdatedAt(ctx, albumID)
}

// RemoveFile removes a file from an album.
func (s *AlbumStore) RemoveFile(ctx context.Context, albumID, fileID string) error {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM album_files WHERE album_id = ? AND file_id = ?`, albumID, fileID)
	if err != nil {
		return fmt.Errorf("remove file from album: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrFileNotInAlbum
	}
	return s.touchUpdatedAt(ctx, albumID)
}

// ListFiles returns all files in an album ordered by position.
func (s *AlbumStore) ListFiles(ctx context.Context, albumID string) ([]*media.File, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT f.id, f.rel_path, f.size_bytes, f.mod_time, f.content_hash,
		        f.status, f.first_seen_at, f.last_seen_at
		 FROM indexed_files f
		 JOIN album_files af ON af.file_id = f.id
		 WHERE af.album_id = ?
		 ORDER BY af.position, f.rel_path`, albumID)
	if err != nil {
		return nil, fmt.Errorf("list album files: %w", err)
	}
	defer func() { _ = rows.Close() }()
	return s.scanFiles(rows)
}

// touchUpdatedAt updates the album's updated_at timestamp.
func (s *AlbumStore) touchUpdatedAt(ctx context.Context, albumID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE albums SET updated_at = ? WHERE id = ?`,
		rfc3339(time.Now().UTC()), albumID)
	return err
}

// --- row scanners ---

type rowScanner interface {
	Scan(dest ...any) error
}

func (s *AlbumStore) scanAlbum(row rowScanner) (*Album, error) {
	var (
		a           Album
		desc        sql.NullString
		coverFileID sql.NullString
		createdStr  string
		updatedStr  string
		previewID   sql.NullString
	)
	err := row.Scan(&a.ID, &a.Name, &desc, &coverFileID, &createdStr, &updatedStr,
		&a.FileCount, &previewID)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("scan album: %w", err)
	}
	a.Description = desc.String
	a.CoverFileID = coverFileID.String
	a.PreviewFileID = previewID.String
	if err := parseTime(createdStr, &a.CreatedAt); err != nil {
		return nil, err
	}
	if err := parseTime(updatedStr, &a.UpdatedAt); err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *AlbumStore) scanAlbums(rows *sql.Rows) ([]*Album, error) {
	var out []*Album
	for rows.Next() {
		a, err := s.scanAlbum(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *AlbumStore) scanFiles(rows *sql.Rows) ([]*media.File, error) {
	var out []*media.File
	for rows.Next() {
		var (
			f        media.File
			modStr   string
			firstStr string
			lastStr  string
			hash     sql.NullString
			status   string
		)
		err := rows.Scan(&f.ID, &f.RelPath, &f.SizeBytes, &modStr, &hash, &status, &firstStr, &lastStr)
		if err != nil {
			return nil, fmt.Errorf("scan file: %w", err)
		}
		f.LibraryID = s.libraryID
		f.ContentHash = hash.String
		f.Status = media.FileStatus(status)
		f.Name = fileBase(f.RelPath)
		f.FolderPath = fileDir(f.RelPath)
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
		out = append(out, &f)
	}
	return out, rows.Err()
}

// --- helpers ---

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

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// fileBase returns the base name of a slash-separated path.
func fileBase(relPath string) string {
	for i := len(relPath) - 1; i >= 0; i-- {
		if relPath[i] == '/' {
			return relPath[i+1:]
		}
	}
	return relPath
}

// fileDir returns the directory part of a slash-separated path.
func fileDir(relPath string) string {
	for i := len(relPath) - 1; i >= 0; i-- {
		if relPath[i] == '/' {
			return relPath[:i]
		}
	}
	return ""
}
