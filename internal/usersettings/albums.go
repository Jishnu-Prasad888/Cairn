package usersettings

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// MaxPinnedAlbums is how many albums one person can pin to the top of Albums.
const MaxPinnedAlbums = 5

// maxHiddenLibraries bounds the hidden-library list; it only ever holds ids
// of libraries that exist, so this is a guard against junk, not a real limit.
const maxHiddenLibraries = 200

// albumSorts are the orders the Albums grid offers.
var albumSorts = map[string]bool{
	"name_asc": true, "name_desc": true, "created_desc": true, "created_asc": true,
}

// PinnedAlbum is one album pinned to the top of the grid. Albums live in a
// library, and their ids are only unique within it.
type PinnedAlbum struct {
	LibraryID string `json:"library_id"`
	AlbumID   string `json:"album_id"`
}

// AlbumSettings are a person's Albums page preferences.
type AlbumSettings struct {
	// Sort orders the grid: by name (A–Z, Z–A) or by when the album was
	// created (newest, oldest).
	Sort string `json:"sort"`
	// Pinned albums lead the grid, most recently pinned first.
	Pinned []PinnedAlbum `json:"pinned"`
	// HiddenLibraries are libraries whose albums the grid leaves out. A search
	// still finds them, in a section of its own.
	HiddenLibraries []string `json:"hidden_libraries"`
}

// DefaultAlbumSettings returns the settings a new account starts with.
func DefaultAlbumSettings() AlbumSettings {
	return AlbumSettings{Sort: "created_desc", Pinned: []PinnedAlbum{}, HiddenLibraries: []string{}}
}

// AlbumPatch changes some album settings; nil fields are left unchanged. A
// list replaces the stored one whole.
type AlbumPatch struct {
	Sort            *string        `json:"sort"`
	Pinned          *[]PinnedAlbum `json:"pinned"`
	HiddenLibraries *[]string      `json:"hidden_libraries"`
}

const albumPrefix = "albums."

// Albums returns a user's album settings with defaults filled in.
func (s *Store) Albums(ctx context.Context, userID string) (AlbumSettings, error) {
	out := DefaultAlbumSettings()
	rows, err := s.db.QueryContext(ctx,
		`SELECT key, value FROM user_settings WHERE user_id = ? AND key LIKE 'albums.%'`, userID)
	if err != nil {
		return out, fmt.Errorf("read user settings: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return out, err
		}
		// A malformed stored value falls back to the default.
		switch key {
		case albumPrefix + "sort":
			var v string
			if json.Unmarshal([]byte(value), &v) == nil && albumSorts[v] {
				out.Sort = v
			}
		case albumPrefix + "pinned":
			var v []PinnedAlbum
			if json.Unmarshal([]byte(value), &v) == nil && validPins(v) == nil {
				out.Pinned = v
			}
		case albumPrefix + "hidden_libraries":
			var v []string
			if json.Unmarshal([]byte(value), &v) == nil && validHidden(v) == nil {
				out.HiddenLibraries = v
			}
		}
	}
	return out, rows.Err()
}

func validID(id string) bool { return id != "" && len(id) <= 128 }

func validPins(pins []PinnedAlbum) error {
	if len(pins) > MaxPinnedAlbums {
		return &ValidationError{msg: fmt.Sprintf("at most %d albums can be pinned", MaxPinnedAlbums)}
	}
	seen := map[PinnedAlbum]bool{}
	for _, p := range pins {
		if !validID(p.LibraryID) || !validID(p.AlbumID) {
			return &ValidationError{msg: "a pinned album needs a library_id and an album_id"}
		}
		if seen[p] {
			return &ValidationError{msg: "an album is pinned twice"}
		}
		seen[p] = true
	}
	return nil
}

func validHidden(ids []string) error {
	if len(ids) > maxHiddenLibraries {
		return &ValidationError{msg: "too many hidden libraries"}
	}
	for _, id := range ids {
		if !validID(id) {
			return &ValidationError{msg: "invalid library id"}
		}
	}
	return nil
}

// UpdateAlbums validates and applies a patch, returning the new settings.
func (s *Store) UpdateAlbums(ctx context.Context, userID string, p AlbumPatch) (AlbumSettings, error) {
	values := map[string]any{}
	if p.Sort != nil {
		if !albumSorts[*p.Sort] {
			return AlbumSettings{}, &ValidationError{msg: fmt.Sprintf("unknown album sort %q", *p.Sort)}
		}
		values["sort"] = *p.Sort
	}
	if p.Pinned != nil {
		pins := *p.Pinned
		if pins == nil {
			pins = []PinnedAlbum{}
		}
		if err := validPins(pins); err != nil {
			return AlbumSettings{}, err
		}
		values["pinned"] = pins
	}
	if p.HiddenLibraries != nil {
		ids := *p.HiddenLibraries
		if ids == nil {
			ids = []string{}
		}
		if err := validHidden(ids); err != nil {
			return AlbumSettings{}, err
		}
		values["hidden_libraries"] = ids
	}
	if err := s.write(ctx, userID, albumPrefix, values); err != nil {
		return AlbumSettings{}, err
	}
	return s.Albums(ctx, userID)
}

// write upserts prefix+key rows for one user in a single transaction.
func (s *Store) write(ctx context.Context, userID, prefix string, values map[string]any) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for key, v := range values {
		raw, err := json.Marshal(v)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			userID, prefix+key, string(raw), now); err != nil {
			return fmt.Errorf("write user setting: %w", err)
		}
	}
	return tx.Commit()
}
