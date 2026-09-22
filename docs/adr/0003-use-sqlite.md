# 0003 — Use SQLite for metadata storage

- Status: accepted
- Date: 2026-09-22

## Context

Cairn stores metadata (files, media, albums, tags, memories, users, permissions,
indexing state). The requirement is single-process, self-hosted, portable
metadata that travels with a library, and low-resource operation. FTS5 full-text
search is required for search.

## Decision

SQLite is the metadata store. The driver is `modernc.org/sqlite`, a pure-Go
implementation, so builds stay CGO-free and portable. We use WAL journaling,
foreign keys, prepared statements, sensible `busy_timeout`/`synchronous`
settings, and a single write connection per database file. Schema evolution uses
versioned SQL migrations (`internal/db/migrations/`).

Server-level data and library-level data live in **separate** SQLite databases
(see ADR-0004).

## Consequences

- Zero-configuration, portable databases travel inside each library's metadata
  directory.
- FTS5 is available natively for full-text search.
- A clean boundary is kept at the persistence layer so migrating to PostgreSQL
  later is possible, but we do not pretend they are interchangeable from day
  one.
- Library databases must never be opened by more than one process.