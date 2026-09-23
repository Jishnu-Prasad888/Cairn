# 0008 — Backup format and subsystem

- Status: implemented
- Date: 2026-09-23

## Context

Cairn is a single-process self-hosted server whose authoritative state is the
server database and each library's `.cairn/` metadata directory. Losing a disk
means losing both media and the entire index (albums, tags, memories, search),
which would be far harder to rebuild than the media itself. Backups must be
simple to operate (no external tools), restoreable into a fresh install, and
graceful about the reality that most users back up onto the same disk the data
lives on.

## Decision

A self-contained, restore-oriented backup format owned by a dedicated
`internal/backups` package:

- **Streaming payload codec** with a fixed header (magic, flags, SHA-256 of
  plaintext, plaintext size, stored size), optional deterministic gzip, and
  optional AES-256-CTR + HMAC-free per-entry encryption via a random IV.
  Sizes and hashes live in the header so verification and restore can stream
  without loading entries into memory.
- **Two-file envelope**: an always-plaintext `header.json` (format, encryption
  flag, argon2id salt) and a payload-encoded `manifest.json` that lists every
  entry (logical path, size, mtime, SHA-256, flags). The manifest is encrypted
  when the backup is, so an encrypted archive leaks nothing.
- **One directory per run** under a configured destination, with server db
  checkpointed before copy, `.cairn` metadata and media mirrored by relative
  path.
- **Encryption key** derived with argon2id from the configured passphrase and a
  fresh per-backup salt stored in `header.json`. The passphrase is never stored.
  Note: AES-CTR provides confidentiality with the hash providing integrity;
  the codec does not emulate an AEAD.
- **Incremental backups via hard links**: unchanged media files (same size,
  mtime) are linked from the most recent completed backup directory rather than
  re-encoded. This works because gzip output is deterministic. Encrypted
  backups always re-copy (fresh IV per run).
- **Retention** keeps the newest `BackupKeep` completed runs; older directories
  are removed and their records marked `pruned`.
- **Sample verification**: after each run and on demand, a bounded sample of
  entries (server db, library dbs, identities, first few + every 27th media
  file, capped) is streamed back and its plaintext hash compared. Failures mark
  the record `verify_status=failed` with a count.
- **Same-device warning**: the record's `same_device` flag reports when the
  destination shares a filesystem with any source, surfacing the "backup on the
  same disk" failure mode.
- **Restore** mirrors the stored layout into an arbitrary destination and
  restores mtimes. Encrypted backups restore with the configured passphrase.
- **Server records**: a `backups` table tracks runs (status, destination,
  counts, bytes, encryption, verification, error), never storing passphrases or
  keys.

API surface is minimal and admin-only: run, list, get, verify, restore.

## Consequences

- A usable backup story ships with no external dependencies (stdlib gzip, AES,
  argon2id already vendored).
- Verification covers plaintext integrity, so it also catches wrong-key decrypt
  attempts.
- Incremental hard links trade extra inodes for skipped recompression; a future
  refinement could re-encode only changed files.
- The format is intentionally Cairn-specific; interop with generic archivers is
  out of scope.
- Encrypted backups sacrifice incrementality and add per-entry salt overhead;
  documented in docs/backups.md.