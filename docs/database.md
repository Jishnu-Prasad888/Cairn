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
embeddings, indexing state, thumbnails, metadata, ML similarity signatures.
Migrated separately when the library is created/adopted.

The two scopes are kept in separate files (ADR-0004) so a library is portable
and self-describing.

## Migrations

Migration files are named `NNNN_description.sql`, applied in ascending numeric
order, each inside its own transaction and recorded in `schema_migrations`.
Migrations are idempotent. Never edit an applied migration; add a new file.

The runner is `internal/db.Migrate` / `MigrateFS` and applies to both scopes.

Server-level applied migrations:

| File                     | Tables added                                   |
| ------------------------ | ---------------------------------------------- |
| `0001_initial.sql`       | `server_settings`                              |
| `0002_auth.sql`          | `users`, `sessions`, `audit_log`               |
| `0003_libraries.sql`     | `libraries`                                    |
| `0004_library_db_schema.sql` | adds `lib_db_schema_version` to `libraries` |
| `0005_permissions.sql`   | `permission_grants`, `shares`                  |
| `0006_backups.sql`       | `backups`                                      |

Library-level applied migrations (`internal/librarydb/migrations/`):

| File                     | Tables added                                   |
| ------------------------ | ---------------------------------------------- |
| `0005_media_schema.sql`  | media tables and indexing state                |
| `0006_search_organization.sql` | `organizations` and FTS5 search support   |
| `0007_memories.sql`      | `memories` and wikilink support                |
| `0008_ml_signatures.sql` | `ml_signatures` (derived perceptual signatures) |

`users` stores argon2id `password_hash`, `role`, and enabled state; `sessions`
stores only the SHA-256 digest (`token_hash`) of each opaque session token;
`audit_log` records security events with optional actor/target and non-sensitive
JSON `metadata`. See [authentication.md](authentication.md) and
[security.md](security.md). `backups` tracks each backup run's destination,
contents, verification result, and retention state; passphrases and keys are
never stored. See [backups.md](backups.md) and ADR-0008.

`ml_signatures` holds derived perceptual hashes per indexed file, keyed by
provider and algorithm version so the built-in and future providers can coexist
and be recomputed independently. It is derived data and can be regenerated with
a similarity pass. See [ml.md](ml.md).

## Futures

- FTS5 for full-text search (search phase).
- No ORM. Queries are explicit SQL with prepared statements.
- The persistence layer is kept behind a small boundary so a future PostgreSQL
  migration is possible without pretending the two are interchangeable today.