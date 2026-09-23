# 0010 — Centralized path sanitizers

- Status: implemented
- Date: 2026-09-23

## Context

Cairn takes filesystem paths from users across many entry points: upload
destinations, rename/move/copy targets, folder listing/search filters, and
backup restore destinations. Path validation historically lived only in
`internal/media.SafeRelPath`, with gaps (a top-level `.cairn` target was
allowed, control characters were allowed, and mid-path `..` components were
silently collapsed rather than rejected). Other subsystems (folders, search,
backups) did not share the same validator, so authorization keys and SQL
filters could receive non-canonical strings and backup restore trusted the
on-disk manifest without a destination-containment check.

## Decision

Introduce a single `internal/sanitize` package holding the canonical path
validators, and route every path-accepting entry point through it:

- **`sanitize.RelPath`** — canonical, relative, slash-separated path scoped to a
  library root. Rejects empty, absolute (post-clean), `.`/`..` components,
  top-level `..`, a top-level `.cairn` component, and control characters.
- **`sanitize.BareName`** — a single filename; `RelPath` rules plus no path
  separators (used for rename destinations).
- **`media.SafeRelPath`** is reimplemented as a thin wrapper over
  `sanitize.RelPath`, retaining `ErrPathTraversal` so the existing HTTP
  `writeMediaError` mapping is unchanged. Because every `media.Service` method
  funnels through `SafeRelPath`, the whole media layer inherits the hardening.
- **`Service.Rename`** validates `new_name` with `sanitize.BareName` before
  composing the destination.
- **HTTP folder filters** (file listing `folder`, folder listing `parent`,
  search `folder`) are canonicalized through `sanitize.RelPath` before use in
  either authorization keys or SQL, so the value is never split across two
  representations; malformed values return `400 BAD_REQUEST`.
- **Backup restore** (`restoreEntry`) verifies each manifest entry's logical
  path stays inside the destination directory before writing, defending against
  a tampered or maliciously crafted manifest.

## Consequences

- Canonical validation is defined once and reused everywhere; future entry
  points get correct path rules by importing `sanitize`.
- Rejecting `.cairn` at the top level prevents user requests from addressing
  Cairn's own metadata directory while leaving normal library content alone.
- Invalid folder/path values now fail fast with 400 rather than producing
  surprising authorization or query behavior.
- Restore becomes destination-containment-safe even against a tampered manifest.
- Legacy indexed libraries are unaffected; only user-supplied path values are
  validated.
- Trade-off: filenames containing control characters (legal on some filesystems
  but pathological) are no longer addressable. This is considered correct
  posture and is documented.