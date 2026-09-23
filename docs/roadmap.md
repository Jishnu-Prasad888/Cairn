# Roadmap

The roadmap tracks Cairn's phases. Each phase maps to work branches
(`phase/<n>-<slug>`); a phase ships when its branch's PR is approved and merged
into `main`. This file is the index; each phase gets design documents in
`docs/` before implementation.

## How to read this

- **Phase 1 is the current deliverable and is tracked as an open PR.**
- Status: `done` = merged to `main`, `in progress` = branch + PR open,
  `planned` = design doc written, `backlog` = not yet started generally.

## Phase 0 — Repository and architecture (done)

Repo scaffolding, Go backend skeleton, embedded React frontend skeleton, build
system, tests, CI, OpenAPI foundation, docs, and ADRs. Merged to `main` via
PR #1.

## Phase 1 — Authentication (in progress)

Users, sessions (HTTP-only cookies), roles (Admin/User), audit log, and the
permission subsystem skeleton. Design: docs/authentication.md, docs/permissions.md.

## Phase 2 — Storage libraries (planned)

Register libraries, detect/adopt existing libraries, metadata directories,
server DB schema for libraries, library status (online/offline), and safe path
handling. Design: docs/libraries.md.

## Phase 3 — Incremental indexing (planned)

Persistent incremental indexer with staged change detection, metadata
extraction, missing-marker reconciliation, and watch-based updates on Linux.
Design: docs/indexing.md.

## Phase 4 — Media (planned)

Full metadata extraction (EXIF, video, audio), thumbnails, photo/video viewers,
time-based views, and bulk upload/download with hardware-tolerant limits.
Design: docs/media.md.

## Phase 5 — Albums and organization (planned)

Albums, tags, folders-as-categories, people, favorites, duplicates, time
clusters, and cleanup workflows — driven by the in-place indexing contract.

## Phase 6 — Permissions and sharing (implemented)

Resource-based permissions and public share links implemented per ADR-0005 and
docs/permissions.md, docs/sharing.md. Authorization is enforced by every content
handler and shares flow through the same evaluation.

## Phase 7 — Memories and full-text search (implemented)

Markdown memories, internal references, keyword search over filenames/paths/
memories with FTS5. Design: docs/memories.md, docs/search.md.

## Phase 8 — Memories, editor, wikilinks (implemented)

Obsidian-style editor with live preview, autosave, version history, wiki-style
object links, and MediaEmbed rendering (MediaEmbed still pending).
Design: docs/markdown.md.

## Phase 9 — Search depth (implemented)

Search filters (tag, album, size, date range), advanced query syntax (OR, AND,
phrases, exclusions, parentheses), and a hardened full-text query builder.
Design: docs/search.md. The query builder, `internal/fts`, is shared by file
and memory search; malformed queries return 400.

## Phase 10 — Backups (implemented)

Incremental, encrypted, compressed, verified backups with retention, same-device
warnings, and restore. Design: docs/backups.md, ADR-0008. The streaming payload
codec (`internal/backups`) is shared by every backup; records live in the
server database; the run/verify/restore surface is admin-only under
`/api/v1/backups`.

## Phase 11 — Local ML (planned)

Optional local-only face recognition, similarity, embeddings; asynchronous,
resource-limited, individually configurable. Design: docs/ml.md.

## Phase 12 — Sanitizers (backlog)

Filename/path sanitizers and safe-path utilities across every entry point.

## Phase 13 — Encrypted metadata (backlog)

Encryption at rest for metadata and media, with optional keys (Plan and docs
drafted in `docs/encryption.md`). Murky privacy territory; do not implement
without consensus.

## Later phases (under design)

Share tokens as server features, webhooks/Plugins, docker compose manifest,
enhanced mobile/time views, physical privacy de-risking, native clients, and
an OpenAPI-driven contract test suite for phase workers.

## Branch conventions

Branches follow `phase/<n>-<slug>`. Each phase's PR describes its scope,
designs to read, and test plan. On merge, this file is updated to `done`.