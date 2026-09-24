# Architecture

## Guiding model

Cairn is a **single-process modular application**.

```text
Cairn
├── Go API server
├── background workers
├── SQLite metadata databases
├── filesystem storage
└── embedded React frontend
```

There are no microservices. Everything runs in one process with explicit,
injected dependencies and clean package boundaries. This keeps the deployment
footprint small enough for a Raspberry Pi while leaving clear seams should
anything ever need to be extracted.

## Layer boundaries

Requests flow through fixed layers, never skipping them:

```text
HTTP Handler        → translations, validation, response shaping
    ↓
Application Service → use cases, orchestration, transactions
    ↓
Domain Logic        → rules that do not depend on HTTP or storage
    ↓
Repository/Storage  → persistence and filesystem access
```

- Handlers stay thin: they never contain business rules.
- Services express use cases and never talk HTTP.
- The domain layer knows nothing about HTTP, JSON, or the web UI.
- The frontend is only ever a client of the HTTP API. No React-specific logic
  lives in the Go backend, so React Native/Flutter/CLI clients are possible.

## Package layout

```text
cmd/cairn/        wiring and the entrypoint
internal/config   environment configuration
internal/logging  slog setup
internal/db       server-level SQLite + migrations
internal/httpapi  HTTP v1 routes, middleware, response envelopes
internal/webui    embedded frontend serving (SPA)
internal/version  build metadata
```

Future phases add packages such as `auth`, `storage`, `indexer`, `media`,
`search`, `memories`, `permissions`, `sharing`, `backup`, and `ml`. Each owns a
single concern and imports only what it needs, top-down.

## Data separation

Cairn separates **server-level data** from **library-level data**:

- Server-level (users, sessions, roles, registered libraries, global settings,
  public shares, audit records) lives in the server SQLite database in the
  server data directory.
- Library-level (files, media, albums, tags, memories, faces, indexing state)
  lives in a per-library SQLite database inside each library's metadata
  directory.

See [storage.md](storage.md) and [database.md](database.md).

## In-place media

The filesystem is the source of truth for actual media bytes. Cairn never
silently moves, duplicates, recompresses, resizes, rotates, or rewrites
originals. All derived data (thumbnails, embeddings, faces, hashes, cache) is
stored inside the library metadata directory and can be regenerated.

## The web UI

The React frontend is compiled and embedded into the Go binary. The Go server
serves it as a single-page application with fallback routing, so the result is
one deployable artifact. In development, the Vite dev server proxies `/api` to
the Go backend. See `docs/web.md` for the page inventory and how to add pages.

## Consistency and concurrency

- SQLite is accessed through `database/sql` with WAL mode.
- Background jobs are bounded and persistent (a later phase).
- Dependency injection avoids hidden globals; tests construct services directly.

## Decisions

Architectural choices are recorded as ADRs in [docs/adr](adr). New decisions
that affect structure or interfaces must be recorded there, not only in commit
messages.