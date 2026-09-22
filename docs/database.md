# Database

Cairn uses **SQLite** behind `database/sql` with the pure-Go driver
`modernc.org/sqlite` (no CGO, fully cross-compilable).

## Configuration

Every Cairn database is opened with:

- `journal_mode = WAL`
- `synchronous = NORMAL`
- `foreign_keys = ON`
- `busy_timeout = 5000` ms

Per-connection pragmas are applied at the driver level (DSN `_pragma`
parameters) so pooled connections are uniformly configured. A single write
connection is used per database file; the server is single-process.

## Two database scopes

### Server-level (`CAIRN_DATA_DIR/cairn.db`)

Instance-scoped data: users, sessions, roles, settings, registered libraries,
global permissions, public shares, audit records. Migrations live in
`internal/db/migrations/`.

### Library-level (`<library>/.cairn/library.db`)

Library-scoped data: files, folders, media, albums, tags, memories, faces,
embeddings, indexing state, thumbnails, metadata. Migrated separately when the
library is created/adopted.

The two scopes are kept in separate files (ADR-0004) so a library is portable
and self-describing.

## Migrations

Migration files are named `NNNN_description.sql`, applied in ascending numeric
order, each inside its own transaction and recorded in `schema_migrations`.
Migrations are idempotent. Never edit an applied migration; add a new file.

The runner is `internal/db.Migrate` / `MigrateFS` and applies to both scopes.

Applied migrations:

| File                     | Tables added                                   |
| ------------------------ | ---------------------------------------------- |
| `0001_baseline.sql`      | `server_settings`                              |
| `0002_auth.sql`          | `users`, `sessions`, `audit_log`               |

`users` stores argon2id `password_hash`, `role`, and enabled state; `sessions`
stores only the SHA-256 digest (`token_hash`) of each opaque session token;
`audit_log` records security events with optional actor/target and non-sensitive
JSON `metadata`. See [authentication.md](authentication.md) and
[security.md](security.md).

## Futures

- FTS5 for full-text search (search phase).
- No ORM. Queries are explicit SQL with prepared statements.
- The persistence layer is kept behind a small boundary so a future PostgreSQL
  migration is possible without pretending the two are interchangeable today.