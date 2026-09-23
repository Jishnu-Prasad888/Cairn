# 0009 — Local ML provider abstraction

- Status: implemented
- Date: 2026-09-23

## Context

Cairn wants optional, local-only ML capabilities (similarity, later faces and
embeddings) with a hard constraint: **no heavyweight model or runtime may be a
build-time requirement** (see docs/ml.md). Every ML capability must be
individually configurable, off by default, fully local, and removable (derived
data can be deleted and regenerated without touching originals).

Bundling, say, an ONNX runtime or a face model would violate the build-time
constraint and would tax the Raspberry Pi-class hardware Cairn targets. But
hard-coding one similarity algorithm with no seam would make later providers
(learned embeddings, faces) an invasive rewrite.

## Decision

A small provider abstraction in `internal/ml`, with one built-in dependency-free
provider and a clear contract for future ones:

- **`Provider` interface**: `Name()`, `Version()`, `Signature(image.Image)
  (uint64, error)`, `Describe()`. Nothing about transport, models, or providers
  leaks into callers; the manager and HTTP layer are provider-agnostic.
- **Built-in provider**: a 64-bit average-hash over 8×8 grayscale (stdlib
  `image` + `golang.org/x/image/draw`, already a module dependency). Zero new
  build-time dependencies.
- **Storage**: signatures live in the per-library SQLite database in a
  `ml_signatures` table (library schema v5) keyed by `file_id`, with
  `provider` + `version` columns so a future algorithm change never corrupts
  existing rows — old signatures are simply unknown to the new version and are
  refreshed, and purging is a plain table delete.
- **Manager**: `internal/ml.Manager` owns pass/status/similar/purge. Passes are
  async with a bounded worker pool, resumable per-file (each new signature is
  written immediately), and idempotent (only files lacking a signature are
  processed). Nothing runs when ML is disabled.
- **HTTP surface**: admin-gated; mirrors the backups pattern. Disabled ML
  returns `SERVICE_UNAVAILABLE`.
- **Faces/embeddings**: explicitly out of scope for this phase. They would
  implement the same `Provider` contract (or a capability-specific extension)
  behind this abstraction when a viable pure-Go option exists or after the
  consensus gate noted for Phase 13.

## Consequences

- Similarity works today with no new dependencies and no network access.
- Future providers are additive: register a provider, keep `provider`+`version`
  in the schema, and callers remain unchanged.
- Average-hash is weak for out-of-phase edits (crops, heavy filters) — an
  acceptable trade for near-duplicate/same-scene search on a personal library;
  a learned embedding provider can later outperform it without restructuring.
- Per-library table storage means derived data is automatically covered by
  backups (Phase 10) and restores, and is removable with one `DELETE`.