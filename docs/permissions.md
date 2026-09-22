# Permissions

Authorization is one of Cairn's most important subsystems and is designed for
long-term scalability (see
[ADR-0005](adr/0005-resource-based-authorization.md)). It is implemented: every
content handler now calls into the authorization service and the model described
here is what the code enforces.

## Model

Permissions are grants on **resources**, with **inheritance** down the resource
hierarchy:

```text
Library
  └── Folder
       └── Folder
            └── Photo
```

A grant on a library or folder applies to its descendants according to the
inheritance rules below. Resources include libraries, folders, files, albums,
memories, and tags. Shares are a separate mechanism (see
[sharing.md](sharing.md)) and flow through the same evaluation.

### Resource keys

Every resource has a stable **resource key** string:

```text
Library   lib-1
Folder    lib-1/f:2024          (nested: lib-1/f:2024/f:Japan)
File      lib-1/f:2024/x:img.jpg
Entity    lib-1/a:albumID       (also m:memoryID, t:tagID)
```

`f:` is a folder, `x:` is a file/media, and `a:` / `m:` / `t:` are entity
markers. Paths in runtime strings (e.g. login-in route keys, list folders) are
converted to keys via the exported builders `LibraryKey`, `FolderKey`, `FileKey`,
`EntityKey`, and `ParseKeyType`.

### Capabilities

The following coarse capabilities exist; every content handler checks the one
(and only the one) that matches the operation:

```text
read      view metadata and content metadata, get thumbnails, list/tree
download  fetch file bytes
create    upload files, create folders/albums/memories/tags
edit      rename, add favorites, manage file-tags and album members,
          update memories, restore
move      move files between folders
delete    move to trash, delete items
share     (admin) manage this resource's shares
manage    (admin) manage this resource's permission grants and shares
```

Roles (`Admin`, `User`) and capability bundles help bootstrap the system but are
never hard-coded `if admin` checks scattered through the application. The only
root bypass lives inside the evaluation function and is driven by the
`Admin` flag on a principal, not by scattered checks.

## Evaluation

`decide()` returns `Allowed` only when a decision (grant) permits and no
more-specific decision denies. Rules:

1. **Most-specific wins.** Depth = number of `/`-separated segments in the key.
   Grants are compared by depth and, within the same depth slot, only one grant
   per principal/resource exists (upsert), so there is a single most-specific
   decision.
2. **Deny beats allow at equal depth.**
3. **Default deny.**
4. **`/`-boundary inheritance.** A grant on `lib-1/f:2024` covers
   `lib-1/f:2024/f:Japan` but not `lib-1/f:20249`.
5. **Strict cross-library isolation.** A key prefixes its library; grants can
   never affect another library (matches are made on the full prefix including
   library-local segments).
6. **Revocation is immediate.** Every mutating grant operation bumps a
   `generation` counter; cached decisions are dropped on generation change, so a
   revoked grant stops affecting the next request.

Effects are `allow` and `deny`. A `deny` grant on a more specific key (e.g. a
single file) revokes an inherited `allow` without walking the tree.

## API

All under `/libraries/{libraryID}/permissions`; require the authenticated user
to hold `manage` on the library and the grant to be rooted in it:

- `GET  /libraries/{libraryID}/permissions` list the library's grants.
- `POST /libraries/{libraryID}/permissions` create a grant
  (`{user_id, key, caps: [...], effect}`).
- `DELETE /libraries/{libraryID}/permissions/{grantID}` revoke a grant.

`key` accepts a bare path (e.g. `2024/Japan`) which is scoped to the library in
the URL, or a fully-qualified key of the same library. Omitting it targets the
library.

On a permission violation handlers return an error envelope with code
`CairnErrForbidden` (HTTP 403); unauthenticated requests get 401.

## Testing commitments

The authorization test suite covers:

- grants, keys, and the helper matrix (authz unit tests)
- nested folders and inheritance at depth
- explicit overrides (`deny` beating inherited `allow`)
- revoked permissions after cached decisions
- capability gating (manage-required endpoints)
- cross-library access attempts
- deleted and disabled users
- public shares (read/download semantics, revocation, password)
- large permission trees (performance)

Authorization never ships as `return true` or ad-hoc checks.