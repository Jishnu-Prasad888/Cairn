# Backups

Backups preserve the server database and every registered library's metadata and
media, so a restored Cairn knows everything it knew. Design: ADR-0008.

Backups go to a **destination**: a folder on the server (an internal disk or a
mounted USB/network drive), or an **SFTP**, **FTP/FTPS** or **SMB** server.
They run on demand, on a **schedule** that survives restarts, and when enough
**new data** arrives (size triggers).

## Scope

A backup always includes:

- the **server database** (`cairn.db`, WAL-checkpointed so it is self-contained),
- each library's **`.cairn/` metadata directory**: `library.json` (identity) and
  `library.db` (indexed files, albums, tags, memories, ...),
- each library's **media files**, stored by their relative path.

## Destinations

| Kind    | Where                                    | Unchanged files            |
| ------- | ---------------------------------------- | -------------------------- |
| `local` | an absolute folder on the server         | hard-linked (or referenced)|
| `sftp`  | SSH server; password and/or private key  | hard-linked (OpenSSH)      |
| `ftp`   | FTP, FTPS explicit (default) or implicit | referenced                 |
| `smb`   | SMB2/3 share (Windows, Samba, NAS)       | referenced                 |

The destination is set on the Backups page (or `PUT /api/v1/backups/settings`
with `destination`). A remote destination is connected to and a probe file is
written and read back before it is saved, so a destination that does not work
is never stored. `POST /api/v1/backups/destination/test` runs the same probe
without saving.

**Credentials** (passwords, SSH private keys) are sealed with AES-256-GCM before
they reach the server database, under a key in `<data-dir>/backup-secrets.key`
(created on first use, mode 0600). The database — which every backup copies,
possibly onto the server those credentials open — never holds them in the
clear, and the API only reports whether one is stored. A database restored
without that key file just asks for the credentials again.

**SFTP host keys** are pinned: the first successful connection (when the
destination is saved) records the server's SHA256 fingerprint, which the UI
shows. A different key later is refused outright — it is not treated as an
outage and not retried. After reinstalling the server, choose "Trust a new key"
(`forget_host_key: true`) and save again.

**Plain FTP** sends the password and every file unencrypted; FTPS is the
default. "Accept a self-signed certificate" (`insecure_skip_verify`) is for NAS
boxes with their own certificates.

### Mounted drives

`GET /api/v1/backups/drives` lists the server's mounted filesystems (USB disks,
second disks, NFS/CIFS mounts) with free space, for the Backups page to offer
as destinations; the system disk is listed but not offered.

When a local destination is saved, the mount it lives on is remembered
(`mount_point`). Before every run Cairn checks that mount is still present. An
unplugged USB drive leaves an empty mountpoint directory behind on the system
disk; without this check a backup would quietly fill the system disk instead.
While the drive is missing, a due backup **waits** — no failed record, no
folder created — and is retried every 10 minutes, so a drive that is only
plugged in now and then still gets its backups. (Mount detection reads
`/proc/self/mountinfo` and is Linux-only; elsewhere the check is skipped.)

## Incremental backups on every destination

A media file whose size and mtime match the previous completed backup on the
same destination is not copied again:

- where the destination can **hard-link** (local filesystems, SFTP with the
  OpenSSH `hardlink@openssh.com` extension) it is linked into the new folder,
  so every backup folder is complete on its own;
- elsewhere (FTP, SMB, exFAT/FAT USB drives) the manifest entry gets a
  **`ref`**: the name of the earlier backup folder that holds the bytes.
  Restore and verify read through it.

Retention understands references. Pruning a backup that newer ones still
reference deletes everything in it *except* the referenced payloads (and its
`header.json`/`manifest.json`), and marks the record `pruned` with
`kept_for_refs`. Once no retained backup references it, the folder is removed.

Encrypted backups are never incremental (each payload gets a fresh nonce), on
any destination.

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

## Retention

`CAIRN_BACKUP_KEEP` (default `4`) keeps the newest completed backups. After each
successful run, older backups on the same destination are deleted and their
records marked `pruned` (see Incremental backups for folders still referenced by
newer backups). Records are never hard-deleted, so an audit trail of all runs remains.

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
"backup on the same disk" failure mode. It is informational; the Backups page
warns about it. Remote destinations never set it.

## Schedule

The schedule is `off`, `interval` (every N minutes, at least 5), `daily` at
`HH:MM`, or `weekly` on a weekday at `HH:MM` (server local time). It is stored
in the server database together with when it **last ran**, so it survives a
restart: if a slot passed while the server was stopped, that backup runs once
about a minute after start, and the schedule continues from there (several
missed slots still mean one catch-up run). Interval schedules also count from
the last completed backup of any kind, so a manual backup resets the clock;
clock-time schedules only count their own runs. Changing the schedule starts it
afresh — it never owes runs from before it was set.

A run that cannot reach its destination waits and retries every 10 minutes
(see Mounted drives); `GET /api/v1/backups/status` reports it as `waiting`. A
backup left `running` by a server that stopped mid-run is marked failed
("interrupted") on the next start; the schedule then runs it again.

`CAIRN_BACKUP_INTERVAL_MIN` is the starting value only: a schedule saved on
the Backups page wins over it.

## Size triggers

Two optional thresholds start a backup between scheduled runs:

- `single_file_bytes` — any one new or changed file at least this large;
- `total_bytes` — new and changed files adding up to at least this much.

Either is enough; `0` turns it off. "New" means the indexer has seen the file
appear (`first_seen_at`) or change (`mod_time`) since the last completed backup
started; files count once a scan has indexed them. The check runs after every
scan and every 10 minutes. A triggered run that fails backs off for 30
minutes; one waiting on its destination retries every 10. `GET
/api/v1/backups/status` reports what is pending (`files`, `bytes`,
`largest_bytes`).

## Restore

`POST /api/v1/backups/{id}/restore` with `{"destination": "<abs-path>"}` streams
every entry back to plaintext under the destination (a folder on the server,
whichever destination the backup is on), mirroring the stored layout
(`server/cairn.db`, `libraries/<id>/...`) and restoring original mtimes. An
encrypted backup restores with the configured passphrase; decrypted content must
be verified by the caller afterward. A backup on a remote destination can be
verified and restored while that destination is the configured one (that is
where its credentials are); local backups are always reachable.

## API

All endpoints are admin-only:

| Method | Path                                  | Action                                    |
| ------ | ------------------------------------- | ----------------------------------------- |
| POST   | `/api/v1/backups`                     | Run a backup now (see below)              |
| GET    | `/api/v1/backups`                     | List recent records                       |
| GET    | `/api/v1/backups/settings`            | Destination, schedule, triggers, policy   |
| PUT    | `/api/v1/backups/settings`            | Set any of `dir`, `destination`, `schedule`, `triggers` |
| POST   | `/api/v1/backups/destination/test`    | Test a destination without saving it      |
| GET    | `/api/v1/backups/status`              | Running, next run, waiting, pending data  |
| GET    | `/api/v1/backups/drives`              | Mounted drives that could hold backups    |
| GET    | `/api/v1/backups/{id}`                | Get one record                            |
| POST   | `/api/v1/backups/{id}/verify`         | Re-verify a completed backup              |
| POST   | `/api/v1/backups/{id}/restore`        | Restore into a destination                |

`POST /api/v1/backups` runs synchronously and returns the finished record. With
`{"background": true}` it returns `202` with the `running` record as soon as
the destination has been reached, and the copy continues; poll the record or
`/status`. The web UI uses background runs, since a backup to a remote server
can outlast an HTTP request. A destination that is not configured or not
reachable is a `409` either way, and creates no record.

Records carry `reason` (`manual`, `schedule`, `size`) and `remote`.

`PUT /api/v1/backups/settings` examples:

```json
{"destination": {"kind": "sftp", "host": "nas.local", "username": "cairn",
                 "password": "…", "path": "/volume1/backups/cairn"}}
{"destination": {"kind": "smb", "host": "nas", "share": "backups",
                 "username": "cairn", "password": "…", "path": "cairn"}}
{"destination": {"kind": "ftp", "host": "ftp.example", "security": "explicit",
                 "username": "cairn", "password": "…", "path": "cairn"}}
{"schedule": {"mode": "weekly", "weekday": 0, "time_of_day": "03:30"}}
{"triggers": {"single_file_bytes": 2147483648, "total_bytes": 10737418240}}
```

Leave `password`/`private_key` out to keep the stored secret (while the kind,
host and username are unchanged); send `""` to clear it.

A run that is already in progress is refused rather than queued.

## Configuration

The destination, schedule and triggers are set by an administrator on the
Backups page (or `PUT /api/v1/backups/settings`). Those choices are stored in
the server database and win over the environment, which only provides starting
values. A local path must be absolute and outside every library; it is created
if missing.

| Variable                        | Default | Meaning                                   |
| ------------------------------- | ------- | ----------------------------------------- |
| `CAIRN_BACKUP_DIR`              | *(empty)* | Starting local destination; empty disables |
| `CAIRN_BACKUP_KEEP`             | `4`     | Completed backups to retain               |
| `CAIRN_BACKUP_INTERVAL_MIN`     | `0`     | Starting interval schedule (`0` = manual) |
| `CAIRN_BACKUP_PASSPHRASE`       | *(empty)* | Encrypts payloads; needed to restore     |

## Limitations

- Encrypted backups are not incremental: fresh nonces means every media file is
  re-encoded each run — and re-uploaded, on a remote destination.
- One destination at a time. Backups on an earlier remote destination stay
  listed but cannot be verified, restored or pruned until it is configured
  again.
- A failed run's partial folder is left in place for inspection; delete it by
  hand if you do not need it.
- Each payload is staged in the system temp directory before it is written to
  the destination, so that needs room for the largest single file.
- Size triggers see files once the indexer has; a file copied into a library
  is counted after the next scan.
- Restore is "everything into one directory" today; selective restore of
  metadata-only (skip media) is a future refinement.
- The backup archive is not portable to non-Cairn consumers; it is a
  restore-oriented format, not an interchange format.