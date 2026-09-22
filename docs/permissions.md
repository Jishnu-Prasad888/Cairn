# Permissions

Authorization is one of Cairn's most important subsystems and is designed for
long-term scalability (see [ADR-0005](adr/0005-resource-based-authorization.md)).
It is not yet implemented (planned phase); this document records the design that
the implementation must satisfy.

## Model

Permissions are grants on **resources**, with **inheritance** down the resource
hierarchy:

```text
Library
  └── Folder
       └── Folder
            └── Photo
```

A grant on a library or folder applies to its descendants according to defined
inheritance rules. Resources include libraries, folders, files, photos, videos,
albums, memories, tags, and shares.

Operations (capabilities):

```text
read   download   create   edit   move   delete   share   manage
```

Roles (`Admin`, `User`) and capability bundles (`viewer`, `editor`) are
convenience layers over the same grant model, never hard-coded `if admin`
checks scattered through the application.

## Requirements

- Efficient evaluation: no recursive traversal of huge filesystem trees per
  request.
- Caching of decisions where safe, with deterministic invalidation.
- Explicit overrides and revocation (a revoked grant beats an inherited one).
- Strict cross-library isolation.
- Deleted/disabled users lose access consistently.
- Public shares do not bypass the same evaluation.

## Testing commitments

The authorization test suite covers:

- nested folders and inheritance at depth
- explicit overrides
- revoked permissions after cached decisions
- cross-library access attempts
- deleted and disabled users
- public shares
- large permission trees (performance)

Authorization never ships as `return true` or ad-hoc checks.