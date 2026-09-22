# Indexing

The indexer is **persistent and incremental**. Its job is to keep the library
database in sync with the real filesystem without expensive repeated work and
without ever touching original files.

## Design contract

- The original file's content must never change because of indexing. This is
  verified by tests: scanning a file leaves its SHA-256 checksum identical
  before and after, and the file size is unchanged.
- Re-indexing an unchanged library is cheap: no content hashing unless size or
  mtime indicates a change.
- Missing files keep their metadata, tags, album memberships, memory links, and
  permissions. Deletions are reconciled, not silently forgotten.

## Architecture

```
Library root
    │
    ▼
Scanner (internal/indexer)
    │  walks filesystem, applies staged detection
    ▼
StateStore (internal/indexer)
    │  persists/queries indexed_files in per-library SQLite
    ▼
per-library library.db  (<root>/.cairn/library.db)
```

Background jobs (`internal/jobs`) make scanning asynchronous and restart-safe.
The `IndexManager` (`internal/indexer`) is the entry point for HTTP handlers.

## Staged change detection

To avoid hashing every file on every scan, identity is decided in stages:

1. **Relative path** within the library root (normalised to forward slashes for
   portability).
2. **File size** and **modification time** — if both match the indexed record,
   the file is marked unchanged and no further work is done.
3. **SHA-256 content hash** — computed only when size or mtime has changed, or
   when the file is new and move detection is needed.

SHA-256 is not computed for unchanged files.

## Scan outcomes

Each file encountered in a scan is classified as one of:

| Outcome | Condition |
|---------|-----------|
| **unchanged** | Same path, size, mtime as indexed record |
| **modified** | Same path, different size or mtime (hash confirms change) |
| **new** | Path not in index, no matching hash found |
| **moved** | Path not in index, but hash matches an existing entry not yet seen in this scan |
| **missing** | Entry in index not encountered anywhere in the walk |

After the walk, all indexed entries that were not visited are marked `missing`.
Missing entries retain all application-level data (tags, album memberships,
memories, permissions).

## Move detection

When a new path is discovered, its SHA-256 hash is looked up in the index. If
an existing entry with the same hash has not yet been visited in this scan pass,
it is treated as a **moved** file rather than a new file. The old path is
replaced with the new path in-place; no new row is created.

Move detection works for:
- files renamed within the same directory
- files moved to a different directory
- files moved and renamed simultaneously (if content is identical)

## Reconciliation

When a library reconnects after being offline (see
[libraries.md](libraries.md)), the indexer reconciles instead of rebuilding.
Files with matching path + size + mtime are left untouched and counted as
`unchanged`. Only genuinely new, modified, or moved files incur the cost of
hashing.

## Background jobs

Index scans run as background jobs in `index_jobs` (per-library SQLite table).

Job lifecycle:
```
queued → running → completed
              └──→ failed (with retry after backoff)
              └──→ cancelled
```

Jobs survive process restarts: any `running` job found at startup is reset to
`queued`. Workers use exponential backoff for retries (10 s × 3 × attempt).

## HTTP API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/libraries/{id}/index` | Enqueue a scan job. Returns `job_id`. |
| `GET`  | `/api/v1/libraries/{id}/index/status` | Present/missing/deleted counts + active job. |

Both endpoints require admin authentication. Scanning an offline library returns
`409 Conflict`.

## File status values

| Status | Meaning |
|--------|---------|
| `present` | File exists at its indexed path |
| `missing` | File was not found on the last scan; metadata retained |
| `deleted` | File has been explicitly removed from the index |

## What the indexer never does

- Reads file content except for SHA-256 hashing (streaming, 32 KiB chunks)
- Writes to any original file
- Moves, renames, or copies original files
- Loads large files into memory (streaming I/O, bounded memory)
- Indexes files inside `.cairn/` (the metadata directory is always skipped)
