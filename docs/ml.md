# Local ML — Phase 11

Phase 11 ships **similarity** as the first local ML capability: a
dependency-free, quadratic-free, privacy-first engine that finds perceptually
similar images inside a library.

Face recognition, CLIP-style embedding vectors, and model versioning are
deliberately **out of scope** for this phase. The subsystem is built behind a
provider abstraction so they can slot in later without restructuring (see
ADR-0009).

## Scope

In scope:

- A perceptual similarity engine (pure Go, stdlib + existing `golang.org/x/image`,
  no new build-time dependency) that derives a small, stable signature per
  image and ranks neighbors by Hamming distance.
- A provider abstraction (`internal/ml`) so alternative similarity/embedding
  providers can be registered without changing callers.
- A per-library async pass: compute signatures for images that lack one, with a
  bounded concurrency limit, idempotent, resumable across restarts.
- Admin-gated HTTP surface: enable/status and "similar files" lookup.
- Derived data is **removable**: deleting signatures (API purge) never touches
  originals and regeneration is safe.

Not in scope (later phases):

- Face detection/recognition (requires a heavy model or runtime — contradicts
  the "no hard build-time dependency" constraint).
- Embedding vectors + nearest-neighbor ANN index.
- Model versioning, model downloads, or any network access.

## Design principles

- **Everything local.** No ML service, no telemetry. Faces and signatures never
  leave the device (nothing is transmitted in this phase regardless — we only
  compute local hashes).
- **Fully optional.** With `CAIRN_ML_ENABLED=false` (the default) the ML
  manager is inert and nothing is computed or stored.
- **Async and resource-limited.** Similarity passes run as a background job
  with a configurable concurrency cap; individual files are processed at low
  priority so indexing and serving are never starved.
- **No hard dependency.** The built-in provider uses the Go standard library
  (`image`, `image/jpeg`, `image/png`, `image/draw`) plus
  `golang.org/x/image/draw`, which is already a module dependency. Providers
  that need heavy runtimes stay optional and unloaded.

## Similarity engine

Per-image signature = a 64-bit perceptual hash (average-hash of the image
downscaled to 8×8 in grayscale). Two files are "similar" when their signatures
differ in few bit positions (Hamming distance below a threshold).

- Downscale to 8×8 via `x/image/draw` (high-quality scaler).
- Reduce to grayscale; compute one 64-bit value (bits above/below the average
  pixel, in raster order). This is the well-known average-hash ("ahash")
  — cheap, rotation/crop-sensitive, but perfectly adequate for "near-duplicate
  and same-scene" queries on a personal library.
- Distance = `bits.OnesCount64(a ^ b)`. Similarity = `(64 - distance) / 64`,
  normalized to `0..1`.
- Threshold: files within Hamming distance ≤ 10 (≥ ~84% similarity) are
  "similar". Volume-tolerant and exposure-tolerant; exact duplicates land at
  distance 0.

This is intentionally not a learned embedding. It gives fast, explainable
results with zero dependencies — the right first ML capability. Model versioning
is avoided by storing the provider name + version alongside each signature, so
a future provider can coexist or be garbage-collected.

## Storage and lifecycle

- Signatures live in the per-library database: a new `ml_signatures` table
  (library schema v5) keyed by `file_id`, storing `provider`, `version`,
  the 64-bit signature, and timestamps. Deriving is idempotent and
  incremental: only files without a row are processed.
- A `cairn-dir` sidecar is **not** used in this phase — derived signatures
  travel with `library.db` exactly like tags/albums do, and are covered by
  backups and restores automatically.
- Deleting derived data = `DELETE FROM ml_signatures` (exposed via an API
  action that purges the table); originals are untouched.

## Architecture

### Provider abstraction (`internal/ml`)

```go
// Provider computes media signatures for similarity search.
type Provider interface {
    Name() string
    // Version identifies the signature algorithm so clients can reason about
    // compatibility. Changing the algorithm bumps this.
    Version() int
    // Signature derives a signature for the decoded image.
    Signature(img image.Image) (uint64, error)
    // Describe returns a short human-readable summary.
    Describe() string
}
```

The built-in `AverageHash` provider honors this interface. A future "faces"
or "embedding" provider implements the same interface plus its own
capability-specific endpoints; callers never branch on provider identity.

### Manager (`internal/ml.Manager`)

- Constructed with the config and library manager; inert unless enabled.
- `Pass(ctx, libID)` — runs one similarity pass over a library: opens the
  library DB, lists indexed files that are images and lack a signature, and
  processes them with a bounded worker pool (default 2, `CAIRN_ML_WORKERS`).
  Resumable: each file's signature is written as soon as it is derived, so a
  cancelled pass makes progress.
- `Status(ctx, libID)` — enabled provider, counts (indexed / signed / pending),
  and last pass timestamp.
- `Similar(ctx, libID, fileID, limit)` — returns the nearest files to a given
  one, with their similarity scores, excluding the query file itself.
- `Forget(ctx, libID)` — deletes all derived signatures for the library.

### Scheduling

The manager does not own a background timer. Similarity passes are triggered by
the indexer completion path (a scan finishing is the natural moment to refresh
signatures) and by an explicit admin API call. Passes are non-blocking: the
HTTP call returns after the pass is enqueued. This keeps ML strictly secondary
to indexing and gives an obvious retry path (`POST .../ml/similarity/pass`).

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `CAIRN_ML_ENABLED` | `false` | Master switch. All ML capabilities are off until this is `true`. |
| `CAIRN_ML_SIMILARITY` | `true` | Whether the similarity capability is on (only consulted when enabled). |
| `CAIRN_ML_WORKERS` | `2` | Max concurrent files per similarity pass. |
| `CAIRN_ML_DISTANCE_THRESHOLD` | `10` | Hamming distance at or below which files are reported as similar. |

With ML disabled, the ML action endpoints (`similarity/pass`, `purge`,
`similar`) return `SERVICE_UNAVAILABLE`; the manager does no work and stores
nothing. The status endpoint still answers `200` with `enabled: false`.

## API

Admin-gated (like backups):

- `GET /api/v1/libraries/{id}/ml` — ML capability status for the library.
- `POST /api/v1/libraries/{id}/ml/similarity/pass` — enqueue a similarity pass
  for the library.
- `GET /api/v1/libraries/{id}/files/{fileID}/similar` — nearest files to a
  given image, with similarity scores.
- `POST /api/v1/libraries/{id}/ml/purge` — delete all derived signatures.

## Files

- `internal/ml/provider.go` — provider abstraction + registry.
- `internal/ml/ahash.go` — built-in average-hash provider.
- `internal/ml/store.go` — `ml_signatures` table access (library db).
- `internal/ml/manager.go` — pass/status/similar/purge operations.
- `internal/ml/manager_test.go` — provider, store, and pass/cancel tests.
- `internal/httpapi/ml.go` — HTTP surface + tests.
- library db schema v5: `ml_signatures` table.

## Out of scope (follow-ups)

- Face recognition (needs a bundled model; revisit when a pure-Go runtime
  exists or after consensus — see Phase 13 note in the roadmap).
- Learned embeddings and ANN search.
- Cross-library similarity.
- Removing per-image derived data via the web UI (API-only in this phase).