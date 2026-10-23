-- 0014_ml_rules: which photos machine learning skips or always includes.
--
-- Applied to each library's <root>/.cairn/library.db. This file documents the
-- DDL that internal/librarydb/librarydb.go applies; the Go code is canonical.
-- A rule is a path inside the library: one file, or a folder and everything
-- under it. "skip" leaves it out of face recognition and similar images (its
-- faces and signatures are discarded); "always" analyses it fully, past skip
-- rules over a parent folder and past the crowd limit. One path has one kind.

CREATE TABLE IF NOT EXISTS ml_rules (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	kind       TEXT NOT NULL CHECK (kind IN ('skip', 'always')),
	path       TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL
);
