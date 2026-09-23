# Roadmap

The roadmap tracks Cairn's phases. Each phase maps to work branches
(`phase/<n>-<slug>`); a phase ships when its branch's PR is approved and merged
into `main`. This file is the index; each phase gets design documents in
`docs/` before implementation.

## How to read this

- **Phase 17 is the current deliverable and is tracked as an open PR.**
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

## Phase 11 — Local ML (implemented)

Optional local-only perceptual-hash similarity search; asynchronous, worker-bounded,
individually configurable and disabled by default. Signatures are derived data in
the library database. Design: docs/ml.md, ADR-0009. Scoped to similarity only;
face recognition and embedding model versioning are deferred and can later
implement the same provider contract.

## Phase 12 — Sanitizers (implemented)

A shared `internal/sanitize` path validator enforced by every path-accepting
entry point: media-safe paths, renames, folder filters on file/folder listing
and search, and backup restore (tampered-manifest containment). Symlink
containment walks are deferred. Design: docs/sanitizers.md, ADR-0010.

## Phase 13 — Encrypted metadata (implemented)

Optional passphrase-driven encryption at rest for Cairn's on-disk metadata:
each library's `.cairn/library.json` identity and generated thumbnails are
sealed with AES-256-GCM (`CAIRN_ENCRYPTION_PASSPHRASE`, argon2id-derived, never
stored). User media originals are never touched (ADR-0004). Implemented after
explicit consensus. Design: docs/encryption.md, ADR-0011.

## Phase 14 — Backup codec hardening to AEAD (implemented)

The backup payload codec now uses one authenticated primitive everywhere:
encrypted backup bodies are sealed with the shared Phase 13 AEAD kernel
(`internal/crypto`, AES-256-GCM via `NewKeysFromKey`) instead of the Phase 10
CTR+SHA-256 scheme. New encrypted backups write `64 KiB` sealed chunks with
authenticated tamper/truncation/wrong-passphrase detection
(`crypto.ErrInvalidPassphrase`/`ErrCorrupt`); legacy CTR payloads already on
disk remain read/verify/restore byte-identical (legacy reader retained and
pinned by a fixture test). Passphrase handling, the REST surface, and the
unencrypted path are unchanged; originals remain untouched (ADR-0004).
Design: docs/designs/014-backup-aead-codec.md, ADR-0012.

## Phase 15 — Face recognition (implemented)

Optional, local face recognition on top of the Phase 11 ML seam: face
detection (`internal/ml` Pigo provider, cascade embedded), per-face appearance
descriptors, incremental clustering into nameable `people`, person-scoped
search, a People UI, and a privacy purge for all derived face data. Everything
is opt-in (`CAIRN_ML_ENABLED` + `CAIRN_ML_FACES`), local, and original-free;
people are library-scoped and travel with the library database. Design:
docs/designs/015-face-recognition.md, ADR-0013.

## Phase 16 — Security hardening (implemented)

A defensive review of the server surface: authentication, authorization,
path traversal, uploads and MIME handling, sessions, shares, XSS, CSRF, SQL
injection, rate limits, secrets, resource isolation, and logging. Findings are
tracked in docs/designs/016-security-hardening.md and fixed behind tests.
Design: docs/designs/016-security-hardening.md, ADR-0014.
Merged to `main` via PR #17.

## Phase 17 — Mobile and API documentation (in progress)

Documentation hardening: finalize the OpenAPI contract, the API reference
(auth, media, upload/download, permissions, sharing), and the mobile development
guide with offline/sync guidance. Every documented endpoint must match the
implemented server; new docs are added where the inventory has gaps.

## Later phases (under design)

Share tokens as server features, webhooks/Plugins, docker compose manifest,
enhanced mobile/time views, physical privacy de-risking, native clients, and
an OpenAPI-driven contract test suite for phase workers.

## Branch conventions

Branches follow `phase/<n>-<slug>`. Each phase's PR describes its scope,
designs to read, and test plan. On merge, this file is updated to `done`.