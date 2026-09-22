# 0005 — Resource-based authorization with inheritance

- Status: accepted
- Date: 2026-09-22

## Context

Cairn exposes libraries, folders, files, albums, memories, tags, and shares.
Access control must scale to large permission graphs without traversing
filesystem trees per request, support inheritance, overrides, and revocation,
and keep cross-library isolation strict. Roles such as Admin/User exist as
conveniences but must not become the fundamental model.

## Decision

Authorization is **resource-based** from the start: permissions are grants on
resources (libraries, folders, files, albums, ...) that inherit down the
resource hierarchy:

```text
Library
  └── Folder
       └── Folder
            └── Photo
```

A grant at a library or folder applies to descendants. Overrides can restrict or
extend a subtree; revocations remove access. Evaluation is designed to be
efficient (no recursive tree scans): grants are stored flat with path-like
prefixes and evaluated with caching where safe, with explicit invalidation.
Authorization is implemented as a dedicated subsystem, never as scattered
`if admin` checks, and never as `return true` stubs.

## Consequences

- Permission logic is testable against large trees (dedicated authorization test
  suite).
- New resource types integrate by declaring their place in the hierarchy.
- This model is implemented in a later phase but the package boundary and
  testing commitment are architectural, hence recorded now.