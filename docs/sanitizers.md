# Sanitizers — Phase 12

Cairn accepts filesystem paths from users in several places: file uploads,
renames, moves, copies, folder listing, search, and backup restore. Phase 12
centralizes path validation in one place (`internal/sanitize`) and wires it into
every entry point so a single upstream fix applies to all of them.

## Threat model

Paths are the one place a user-directed value can become an operating-system
action. The concrete risks:

- **Traversal**: `../` or absolute paths escaping the library root, letting a
  request read or write outside its sandbox.
- **Cairn metadata directory**: a request that targets `.cairn/` (the library's
  own database/state directory) could overwrite or expose Cairn's internals.
- **Inconsistent authorization keys**: folder parameters passed both to
  `authz` keys and to SQL filters become two different things if they are not
  canonicalized first ("`2022`" vs "`./2022`" vs "`2022/../2022`").
- **Backup restore targets**: restoring a backup must write strictly inside the
  requested destination and nowhere else, even if the on-disk manifest has been
  tampered with.

## Design

A single new package, `internal/sanitize`, provides two validators:

### `RelPath(raw string) (string, error)`

Validates a caller-supplied **relative library path** (a file or folder path
scoped to a library root). Returns the canonical, slash-separated path.

Rejects:

- empty input,
- paths that are absolute (or become absolute after cleaning),
- `.` and `..` components (including `/../` in the middle, which `filepath.Clean`
  normally collapses — the validator rejects them outright so a path of
  `a/../../b` cannot silently become `../b`),
- a leading top-level `..` (traversal),
- a **top-level `.cairn` component** — the metadata directory is reserved and
  never addressable as library content,
- control characters (`\x00`-`\x1f`, `\x7f`) anywhere in the path — they are
  illegal on most filesystems, break logs, and enable terminal/markup tricks.

Allows: nested relative paths such as `2022/photos/a.jpg`, single names, and
names with spaces, unicode, and realistic special characters.

### `BareName(raw string) (string, error)`

Validates a **single filename** with no path structure (used for rename
destinations). Rejects anything a rel path must reject **plus** any path
separator (`/` or `\`), so a rename cannot smuggle a directory change.

## Wiring

### `internal/media`

- `media.SafeRelPath` (media/types.go) is reimplemented on top of
  `sanitize.RelPath`. Every `Service` method (upload/rename/move/copy/delete/
  open) already funnels through it, so hardening one function hardens the whole
  media layer. `ErrPathTraversal` is preserved so the HTTP layer's
  `writeMediaError` mapping (400 + `BAD_REQUEST`) is unchanged.
- `Service.Rename` additionally validates `newName` with `sanitize.BareName`
  **before** composing the destination path, instead of only after.

### `internal/httpapi`

- `handleListFiles` (`folder` query param), `handleListFolders` (`parent`
  query param), and the search handler (`folder`) canonicalize their folder
  argument through `sanitize.RelPath` before it reaches either an `authz` key
  or a SQL filter. Invalid values produce `400 BAD_REQUEST` instead of
  surprising authorization behavior. `""`/`"."` still means the library root.
- This closes the "inconsistent keys" gap: the same canonical string is used
  for capability checks and for the store query.

### `internal/backups`

- `restoreEntry` validates each manifest entry's `Logical` path against the
  restore destination before opening any file, so a crafted `cairn.db` manifest
  on disk cannot write outside the destination directory. Valid logical paths
  (which are always relative and contain neither `.` nor `..` components) are
  unaffected.

## Out of scope

- **Symlink containment** (`EvalSymlinks` walks on every access) — expensive
  per-file and a broader change; noted as a follow-up. Library roots are
  admin-supplied and indexed content is re-verified by the scanner.
- Filesystem-level ACLs, per-file quarantine, or filesystem hardening.

## API/behavior impact

- Paths that previously slipped through `SafeRelPath` (e.g. `foo/../bar` after
  cleaning) are now rejected with `400 BAD_REQUEST`.
- Files outside `.cairn` are unaffected; existing indexed libraries keep working.
- The `folders`, `files?folder=`, and search `folder` parameters now reject
  malformed (traversing/absolute) values with 400 instead of returning
  authorization or empty results.

## Files

- `internal/sanitize/sanitize.go` — validators.
- `internal/sanitize/sanitize_test.go` — validator tests.
- `internal/media/types.go` — `SafeRelPath` delegates to `sanitize.RelPath`.
- `internal/media/service.go` — `Rename` uses `sanitize.BareName`.
- `internal/httpapi/media.go`, `internal/httpapi/search.go` — folder canonicalization.
- `internal/backups/manager.go` — restore destination containment.
- `docs/adr/0010-path-sanitizers.md`.