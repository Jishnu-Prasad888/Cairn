-- 0015_favorite_folders_duplicate_ignores: starred folders, and duplicate
-- groups the user chose to keep.
--
-- Applied to each library's <root>/.cairn/library.db. This file documents the
-- DDL that internal/librarydb/librarydb.go applies; the Go code is canonical.

-- A folder has no id of its own, so it is starred by path. Renaming or moving
-- it through Cairn rewrites the path here.
CREATE TABLE IF NOT EXISTS favorite_folders (
	rel_path   TEXT PRIMARY KEY,
	created_at TEXT NOT NULL
);

-- A duplicate group is every present file sharing one content hash. An
-- ignored hash is left off the duplicates page until it is un-ignored.
CREATE TABLE IF NOT EXISTS duplicate_ignores (
	content_hash TEXT PRIMARY KEY,
	created_at   TEXT NOT NULL
);
