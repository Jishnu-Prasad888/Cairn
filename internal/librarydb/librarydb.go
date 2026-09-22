// Package librarydb manages per-library SQLite databases.
//
// Each Cairn library keeps its own SQLite database at <root>/.cairn/library.db.
// This database holds library-scoped data: indexed files, folders, jobs,
// thumbnails, embeddings, and any other data that travels with the library.
//
// The server-level database (internal/db) is used for global concerns:
// user accounts, sessions, registered libraries, global settings, and audit
// records.
package librarydb

import (
	"database/sql"
	"fmt"
	"path/filepath"

	_ "modernc.org/sqlite" // pure-Go SQLite driver
)

const (
	// dbFileName is the per-library database filename inside .cairn/.
	dbFileName = "library.db"

	// SchemaVersion is the current version of the library-level database
	// schema. Bump this when adding new tables or changing existing ones.
	SchemaVersion = 3
)

// DB wraps a per-library SQLite connection pool. Use OpenDB to construct one.
type DB struct {
	pool *sql.DB
}

// DB returns the underlying *sql.DB connection pool.
func (d *DB) DB() *sql.DB { return d.pool }

// Close closes the underlying connection pool.
func (d *DB) Close() error { return d.pool.Close() }

// OpenDB opens (creating if necessary) the per-library SQLite database at
// <cairnDir>/library.db and applies any pending schema migrations.
func OpenDB(cairnDir string) (*DB, error) {
	pool, err := Open(cairnDir)
	if err != nil {
		return nil, err
	}
	return &DB{pool: pool}, nil
}

// Open opens (creating if necessary) the per-library SQLite database at
// <cairnDir>/library.db and applies any pending schema migrations.
func Open(cairnDir string) (*sql.DB, error) {
	path := filepath.Join(cairnDir, dbFileName)
	pool, err := sql.Open("sqlite", dsn(path))
	if err != nil {
		return nil, fmt.Errorf("open library database: %w", err)
	}
	pool.SetMaxOpenConns(1)
	pool.SetMaxIdleConns(1)
	pool.SetConnMaxLifetime(0)
	pool.SetConnMaxIdleTime(0)

	if err := pool.Ping(); err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("ping library database: %w", err)
	}
	if _, err := pool.Exec(`PRAGMA journal_mode = WAL`); err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("enable WAL: %w", err)
	}
	if err := migrate(pool); err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("migrate library database: %w", err)
	}
	return pool, nil
}

func dsn(path string) string {
	pragmas := []string{
		"foreign_keys(1)",
		"busy_timeout(5000)",
		"synchronous(NORMAL)",
		"journal_mode(WAL)",
	}
	u := "file:" + filepath.ToSlash(path) + "?"
	for i, p := range pragmas {
		if i > 0 {
			u += "&"
		}
		u += "_pragma=" + p
	}
	return u
}

// migrate applies the per-library schema. Each statement is idempotent via
// CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
func migrate(db *sql.DB) error {
	_, err := db.Exec(schema)
	return err
}

// schema is the canonical per-library DDL. All tables use CREATE TABLE IF NOT
// EXISTS so the function is safe to call on an already-initialised database.
const schema = `
-- Tracking table for every file the indexer has seen under the library root.
-- Relative paths are relative to the library root (never absolute) so the
-- library remains portable when remounted at a different path.
CREATE TABLE IF NOT EXISTS indexed_files (
	id            TEXT PRIMARY KEY,
	rel_path      TEXT NOT NULL UNIQUE,
	size_bytes    INTEGER NOT NULL,
	mod_time      TEXT NOT NULL,
	content_hash  TEXT,
	status        TEXT NOT NULL DEFAULT 'present'
		CHECK (status IN ('present', 'missing', 'deleted')),
	first_seen_at TEXT NOT NULL,
	last_seen_at  TEXT NOT NULL,
	indexed_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS indexed_files_rel_path_idx ON indexed_files (rel_path);
CREATE INDEX IF NOT EXISTS indexed_files_status_idx   ON indexed_files (status);
CREATE INDEX IF NOT EXISTS indexed_files_hash_idx     ON indexed_files (content_hash)
	WHERE content_hash IS NOT NULL;

-- Background job queue for library-scoped operations.
-- Jobs are persisted so they survive process restarts; a job that was
-- 'running' at shutdown is reset to 'queued' on the next startup.
CREATE TABLE IF NOT EXISTS index_jobs (
	id           TEXT PRIMARY KEY,
	kind         TEXT NOT NULL,
	status       TEXT NOT NULL DEFAULT 'queued'
		CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
	priority     INTEGER NOT NULL DEFAULT 0,
	payload      TEXT NOT NULL DEFAULT '{}',
	result       TEXT,
	error_msg    TEXT,
	attempt      INTEGER NOT NULL DEFAULT 0,
	max_attempts INTEGER NOT NULL DEFAULT 3,
	created_at   TEXT NOT NULL,
	started_at   TEXT,
	finished_at  TEXT,
	next_run_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS index_jobs_status_idx      ON index_jobs (status);
CREATE INDEX IF NOT EXISTS index_jobs_next_run_idx    ON index_jobs (next_run_at)
	WHERE status IN ('queued', 'failed');

-- folders tracks directories under the library root that contain indexed files.
CREATE TABLE IF NOT EXISTS folders (
	id           TEXT PRIMARY KEY,
	rel_path     TEXT NOT NULL UNIQUE,
	parent_id    TEXT REFERENCES folders(id),
	name         TEXT NOT NULL,
	file_count   INTEGER NOT NULL DEFAULT 0,
	created_at   TEXT NOT NULL,
	updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS folders_rel_path_idx ON folders (rel_path);
CREATE INDEX IF NOT EXISTS folders_parent_idx   ON folders (parent_id);

-- media_metadata stores media-specific attributes derived from indexed files.
-- Rows are regenerable; keyed on indexed_files.id for efficient joins.
CREATE TABLE IF NOT EXISTS media_metadata (
	file_id       TEXT PRIMARY KEY REFERENCES indexed_files(id) ON DELETE CASCADE,
	media_type    TEXT NOT NULL DEFAULT 'other'
		CHECK (media_type IN ('photo','video','audio','document','other')),
	mime_type     TEXT,
	width         INTEGER,
	height        INTEGER,
	duration_secs REAL,
	taken_at      TEXT,
	camera_make   TEXT,
	camera_model  TEXT,
	latitude      REAL,
	longitude     REAL,
	has_thumbnail INTEGER NOT NULL DEFAULT 0,
	updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS media_metadata_type_idx ON media_metadata (media_type);

-- trash records soft-deleted files for restore or permanent deletion.
CREATE TABLE IF NOT EXISTS trash (
	file_id         TEXT PRIMARY KEY REFERENCES indexed_files(id) ON DELETE CASCADE,
	original_path   TEXT NOT NULL,
	trash_path      TEXT NOT NULL,
	deleted_at      TEXT NOT NULL,
	deleted_by      TEXT
);

-- fts_files is a FTS5 virtual table for full-text search over file paths and
-- names. The file_id column is UNINDEXED (stored but not tokenized) so
-- searches only match against rel_path. The default unicode61 tokenizer splits
-- on '/' and '.' so searching "beach" matches "holiday/beach.jpg".
CREATE VIRTUAL TABLE IF NOT EXISTS fts_files USING fts5(
	file_id UNINDEXED,
	rel_path
);

-- Keep fts_files in sync with indexed_files.
CREATE TRIGGER IF NOT EXISTS fts_files_insert AFTER INSERT ON indexed_files BEGIN
	INSERT INTO fts_files(file_id, rel_path) VALUES (new.id, new.rel_path);
END;

CREATE TRIGGER IF NOT EXISTS fts_files_update AFTER UPDATE OF rel_path ON indexed_files BEGIN
	DELETE FROM fts_files WHERE file_id = old.id;
	INSERT INTO fts_files(file_id, rel_path) VALUES (new.id, new.rel_path);
END;

CREATE TRIGGER IF NOT EXISTS fts_files_delete AFTER DELETE ON indexed_files BEGIN
	DELETE FROM fts_files WHERE file_id = old.id;
END;

-- tags holds user-defined labels that can be attached to any indexed file.
CREATE TABLE IF NOT EXISTS tags (
	id         TEXT PRIMARY KEY,
	name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
	color      TEXT,
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tags_name_idx ON tags (name COLLATE NOCASE);

-- file_tags is the many-to-many join between files and tags.
CREATE TABLE IF NOT EXISTS file_tags (
	file_id    TEXT NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
	tag_id     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
	created_at TEXT NOT NULL,
	PRIMARY KEY (file_id, tag_id)
);

CREATE INDEX IF NOT EXISTS file_tags_tag_idx  ON file_tags (tag_id);
CREATE INDEX IF NOT EXISTS file_tags_file_idx ON file_tags (file_id);

-- albums groups files into named collections without moving them on disk.
CREATE TABLE IF NOT EXISTS albums (
	id            TEXT PRIMARY KEY,
	name          TEXT NOT NULL,
	description   TEXT,
	cover_file_id TEXT REFERENCES indexed_files(id) ON DELETE SET NULL,
	created_at    TEXT NOT NULL,
	updated_at    TEXT NOT NULL
);

-- album_files is the ordered many-to-many join between albums and files.
CREATE TABLE IF NOT EXISTS album_files (
	album_id   TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
	file_id    TEXT NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
	position   INTEGER NOT NULL DEFAULT 0,
	added_at   TEXT NOT NULL,
	PRIMARY KEY (album_id, file_id)
);

CREATE INDEX IF NOT EXISTS album_files_album_idx ON album_files (album_id, position);

-- favorites records files that the user has starred.
CREATE TABLE IF NOT EXISTS favorites (
	file_id    TEXT PRIMARY KEY REFERENCES indexed_files(id) ON DELETE CASCADE,
	created_at TEXT NOT NULL
);
`
