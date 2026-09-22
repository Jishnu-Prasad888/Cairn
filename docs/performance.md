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

## Measurement

Benchmarks and profiles live with the subsystems that introduce them. The
repository carries no synthetic microbenchmarks pretending to predict widget
latency; they are added with the code they measure and must pass in CI.