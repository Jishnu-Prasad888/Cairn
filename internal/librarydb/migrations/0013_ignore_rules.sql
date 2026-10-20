-- 0013_ignore_rules: what the scanner leaves out of a library's index.
--
-- Applied to each library's <root>/.cairn/library.db. This file documents the
-- DDL that internal/librarydb/librarydb.go applies; the Go code is canonical.
-- A rule is a path inside the library (a folder and everything under it, or
-- one file), a file extension, or a name pattern matched against every file
-- and folder name. Files already indexed that a rule now covers are marked
-- missing on the next scan, so their tags and albums return if it is removed.

CREATE TABLE IF NOT EXISTS ignore_rules (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	kind       TEXT NOT NULL CHECK (kind IN ('path', 'extension', 'name')),
	pattern    TEXT NOT NULL,
	created_at TEXT NOT NULL,
	UNIQUE (kind, pattern)
);
