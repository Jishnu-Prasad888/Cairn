# Backups

Backups preserve the server database and every registered library's metadata and
media, so a restored Cairn knows everything it knew. Design: ADR-0008.

## Scope

A backup always includes:

- the **server database** (`cairn.db`, WAL-checkpointed so it is self-contained),
- each library's **`.cairn/` metadata directory**: `library.json` (identity) and
  `library.db` (indexed files, albums, tags, memories, ...),
- each library's **media files**, stored by their relative path.

## On-disk layout

```text
<backup-dir>/
  cairn-backup-<timestamp>/          # one directory per run
    header.json                      # plaintext; format, salt when encrypted
    manifest.json                    # payload-encoded (encrypted when configured)
    server/cairn.db
    libraries/<lib-id>/
      library.db
      library.json
      files/<relative-media-path>
```

Two files describe the backup:

- **`header.json`** is always plaintext. It records the format, version, whether
  the payloads are encrypted, and the per-backup argon2id salt (hex) when they
  are.
- **`manifest.json`** lists every entry (logical path, original absolute path,
  size, mtime, SHA-256, compression/encryption flags) and is itself written
  through the payload codec — so an encrypted backup's manifest is encrypted too.

## Payload codec

Every entry is written with the same streaming codec (`internal/backups`):

- a fixed 57-byte header: magic `CAIRNBK\x01`, flags byte, SHA-256 of the
  plaintext, plaintext size, stored size,
- optional gzip so already-compressed (media) data is stored raw,
- optional encryption via the **shared AEAD kernel** (Phase 14): when a backup
  is passphrase-encrypted the body is a sequence of independent AES-256-GCM
  sealed blobs (`internal/crypto`, same format used for `.cairn` identities and
  thumbnails). Each `64 KiB` chunk is authenticated, so a tampered, truncated,
  or wrong-passphrase payload fails fast with the kernel's typed errors
  (`crypto.ErrInvalidPassphrase` / `crypto.ErrCorrupt`) instead of silently
  glitching or being partially restored.

The header's flags byte also carries an `AEADSealed` bit for self-documentation;
the AEAD magic at the start of the body disambiguates new sealed payloads from
legacy encrypted payloads written by pre-Phase-14 releases (AES-256-CTR with a
16-byte IV, unkeyed SHA-256). Legacy CTR backups remain readable, verifiable,
and restorable byte-for-byte; new encrypted backups are always AEAD-sealed.

Writes go to a temp file and are `Materialize`d into place, so sizes are known
upfront and memory stays bounded.

### Compression

gzip is applied unless the file is an already-compressed format (JPEG/PNG/WebP/
HEIC, MP4/MKV/MOV, MP3/FLAC/AAC, ZIP/GZ/7z/RAR/TAR, ...). gzip output is
deterministic (OS/time fields zeroed) so unchanged files produce identical
bytes across runs — which is what enables incremental backups.

### Encryption

When `CAIRN_BACKUP_PASSPHRASE` is set, every payload (including the manifest)
is encrypted. The key is derived with argon2id from the passphrase and a fresh
random 16-byte salt per backup; the salt is stored in `header.json`. The
passphrase is never stored anywhere. Restoring or verifying an encrypted backup
requires the same passphrase to be configured.

## Incremental backups

After a run completes, the next run consults the most recent completed backup's
manifest. A media file whose size and mtime exactly match the previous run is
**hard-linked** from the previous backup directory instead of being re-encoded
(with a checksum from the previous manifest). This only applies to unencrypted
backups: an encrypted entry is re-encrypted with a fresh nonce every run, so
encrypted backups always copy their media.

Metadata payloads (server db, library dbs, identity files) are always re-copied;
they are small.

## Retention

`CAIRN_BACKUP_KEEP` (default `4`) keeps the newest completed backups. After each
successful run, older backup directories are deleted and their records marked
`pruned`. Records are never hard-deleted, so an audit trail of all runs remains.

## Verification

Each completed backup is verified before the run returns and again on demand via
`POST /api/v1/backups/{id}/verify`. Verification restores a sample of entries —
the server db, each library db, each identity file, the first few media files
and then every 27th, capped at 12 entries — and compares the streamed-back
plaintext against the recorded SHA-256 and size. Failures are recorded as
`verify_errors` and flip the record's `verify_status` to `failed`. Because the
hash is over the *plaintext*, verification catches both storage corruption and
wrong-key decryption.

## Same-device warning

The record's `same_device` is set when the backup destination is on the same
physical filesystem as the server database or any library root — the common
"backup on the same disk" failure mode. It is informational today; the API
exposes it so a UI can warn.

## Restore

`POST /api/v1/backups/{id}/restore` with `{"destination": "<abs-path>"}` streams
every entry back to plaintext under the destination, mirroring the stored layout
(`server/cairn.db`, `libraries/<id>/...`) and restoring original mtimes. An
encrypted backup restores with the configured passphrase; decrypted content must
be verified by the caller afterward.

## API

All endpoints are admin-only:

| Method | Path                                | Action                          |
| ------ | ----------------------------------- | ------------------------------- |
| POST   | `/api/v1/backups`                   | Run a backup now (synchronously)|
| GET    | `/api/v1/backups`                   | List recent records             |
| GET    | `/api/v1/backups/{id}`              | Get one record                  |
| POST   | `/api/v1/backups/{id}/verify`       | Re-verify a completed backup    |
| POST   | `/api/v1/backups/{id}/restore`      | Restore into a destination      |

A run that is already in progress is refused rather than queued.

## Configuration

| Variable                        | Default | Meaning                                   |
| ------------------------------- | ------- | ----------------------------------------- |
| `CAIRN_BACKUP_DIR`              | *(empty)* | Where backups are written; empty disables |
| `CAIRN_BACKUP_KEEP`             | `4`     | Completed backups to retain               |
| `CAIRN_BACKUP_INTERVAL_MIN`     | `0`     | Scheduled cadence in minutes (`0` = manual) |
| `CAIRN_BACKUP_PASSPHRASE`       | *(empty)* | Encrypts payloads; needed to restore     |

## Limitations

- Encrypted backups are not incremental: fresh nonces means every media file is
  re-encoded each run.
- Restore is "everything into one directory" today; selective restore of
  metadata-only (skip media) is a future refinement.
- The backup archive is not portable to non-Cairn consumers; it is a
  restore-oriented format, not an interchange format.