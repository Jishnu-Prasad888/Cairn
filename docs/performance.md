# Performance

Performance goals and commitments.

## Principle

The filesystem is the source of truth for media; metadata in SQLite lets Cairn
answer most questions without touching media bytes. `stat`-heavy operations are
avoided; content hashing is reserved (see [indexing.md](indexing.md)).

## Targets (later phases)

- Library index of 100k+ photos/videos: initial scan streams metadata, doesn't
  saturate I/O for the whole library at once.
- Re-scan of an unchanged library: cheap (no rehashing).
- Time-based album / memory queries served from SQLite indexes.
- Watch-oriented updates (inotify) on Linux with graceful fallbacks.
- Set concurrency limits on all background work (indexer, thumbnails, ML).
  Never assume unlimited CPU/RAM; profiles for AMD64 desktop and ARM64 Pi.

## What is in place

- **Shared library database pools.** Request handlers, index status and ML
  calls borrow one pool per library (`librarydb.Acquire`) instead of opening
  the SQLite file per request. A pool closes after 30 s idle (so Windows can
  move the files and a removable drive can be ejected) and is replaced if
  `library.db` is swapped out underneath it. Schema DDL runs once per process
  per library; the stamp in `PRAGMA user_version` makes a restored or
  recreated file migrate again.
- **Batched indexing.** Scan writes are buffered and committed in
  transactions of up to 500 rows or 250 ms, never while a file is being
  hashed, so other writers are not held up. Follow-up media jobs are enqueued
  in batches, and files are classified (`media_type`) as they are indexed.
- **Background jobs drain back to back** and media jobs run on a bounded pool
  (`CAIRN_MEDIA_WORKERS`, default half the CPUs, 1–4: two on a Raspberry
  Pi 4). Scans of one library never overlap. The claim query walks an index
  rather than sorting the queue.
- **Thumbnails** are cached by the browser for good when the URL carries the
  file's version (`?v=<mod_time>-<size>`); otherwise they revalidate with a
  304 that never reads or decrypts the file. A thumbnail older than its file
  is regenerated on request, and a scan drops the thumbnail of a modified file.
- **Compression.** JSON API responses are gzipped for clients that accept it;
  the embedded web UI is gzipped once and kept in memory, with ETags.
- **Index-backed folder views.** Folder filters pair the escaped `LIKE` with a
  `rel_path` range so SQLite seeks the folder instead of scanning the library.
- **Small binary.** The embed step clears old bundles and leaves source maps
  out; release binaries are ~15 MB for linux, darwin and windows on amd64
  and arm64.

## Measurement

Benchmarks and profiles live with the subsystems that introduce them. The
repository carries no synthetic microbenchmarks pretending to predict widget
latency; they are added with the code they measure and must pass in CI.