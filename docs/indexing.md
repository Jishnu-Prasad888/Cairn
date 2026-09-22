# Indexing

The indexer is **persistent and incremental**. Its job is to keep the library
database in sync with the real filesystem without expensive, repeated work and
without ever touching original files.

## Design contract

- The original file's content must never change because of indexing. This is
  verified by tests: indexing a file leaves its checksum identical.
- Re-indexing an unchanged library is cheap (no content hashing unless needed).
- Missing files keep their metadata, tags, album memberships, memory links, and
  permissions. Deletions are reconciled, not silently forgotten.

## Staged change detection

To avoid hashing every file on every scan, identity is decided in stages:

1. **Relative path** within the library.
2. **File size.**
3. **Modification time** (and filesystem metadata where available).
4. **Content hash** only when the above are ambiguous or explicitly required
   (e.g. duplicate detection, checksum-backed workflows).

SHA-256 is not computed for unchanged files.

## Scan outcomes

A scan detects:

- new files → identify, extract metadata, index
- changed files → refresh metadata
- deleted files → mark missing; keep application-level data
- missing files → same as deleted, flagged for reconciliation
- moved files → detected via change heuristics (size + mtime + name similarity)
- renamed files → detected similarly; identity and metadata preserved
- duplicate files → content hash groups for the duplicates phase
- corrupted/inaccessible files → recorded with errors, never fatal

## Reconciliation

When a library reconnects after being offline (see
[libraries.md](libraries.md)), the indexer reconciles instead of rebuilding:
entries whose stated identity metadata still matches are left untouched.