# Media API

Cairn's media surface lets clients browse, upload, download, organize, and
delete files inside a library. This document is the reference for the
`/libraries/{libraryID}/files*` endpoints; the machine-readable contract is
[openapi.yaml](openapi.yaml).

All content endpoints are scoped to one library and require a session cookie
(`cookieAuth` in the OpenAPI document). Read on for the exact wire shapes,
pagination rules, and streaming behavior. The generic conventions (base URL,
error envelope, request IDs) are in [api.md](api.md).

## File object

Every file endpoint returns a `file` object with these fields:

| Field          | Type   | Description                                                        |
| -------------- | ------ | ------------------------------------------------------------------ |
| `id`           | string | Stable file id, unique within the library.                        |
| `library_id`   | string | Owning library id.                                                 |
| `rel_path`     | string | Path relative to the library root, always `/`-separated.          |
| `name`         | string | Basename of `rel_path`.                                            |
| `folder_path`  | string | Parent directory, `.` for the library root.                       |
| `size_bytes`   | int    | File size in bytes.                                                |
| `mod_time`     | string | Modification time in RFC 3339 UTC.                                |
| `media_type`   | string | One of `photo`, `video`, `audio`, `document`, `other`.           |
| `mime_type`    | string | Best-effort MIME type.                                             |
| `status`       | string | One of `present`, `missing`, `deleted`.                           |
| `content_hash` | string | Present only when the indexer computed one.                       |

Example:

```json
{
  "file": {
    "id": "a1b2c3d4e5f60718",
    "library_id": "9f2d1c7aa38b4c21",
    "rel_path": "vacation/beach.jpg",
    "name": "beach.jpg",
    "folder_path": "vacation",
    "size_bytes": 2451200,
    "mod_time": "2026-06-14T17:30:04Z",
    "media_type": "photo",
    "mime_type": "image/jpeg",
    "status": "present",
    "content_hash": "7e3d9c1a2b88f4e6d5c0a1b2c3d4e5f60718293a4b5c6d7e8f9"
  }
}
```

### Media types

Classification is by file extension, case-insensitively. The W3C-independent
set: `photo` covers common image formats (JPEG, PNG, WebP, HEIC/HEIF, AVIF,
RAW family, …), `video` covers MP4, MKV, MOV, WebM, MTS, …, `audio` covers
MP3, FLAC, AAC, OGG, WAV, …, `document` covers PDF, DOC(X), XLS(X), ODT,
TXT, MD, … and everything else is `other`.

The `index` phase (Phase 3) is what populates `mod_time`, `size_bytes`,
`content_hash`, and `status`. Files that were never indexed do not appear in
listings.

## Listing files

```
GET /api/v1/libraries/{libraryID}/files
```

Returns a page of files:

```json
{
  "files": [ { "id": "...", "rel_path": "...", ... } ],
  "next_cursor": "…",
  "total": 1234
}
```

- `files` is the page, ordered by `sort`/`order`.
- `next_cursor` is opaque; pass it as the `cursor` query parameter to fetch
  the next page. Empty string means the end.
- `total` is the approximate count of matching rows without pagination.

### Query parameters

| Parameter   | Values                                     | Default   | Notes                                                    |
| ----------- | ------------------------------------------ | --------- | -------------------------------------------------------- |
| `folder`    | relative path or `.`                       | `.`       | Restrict to files directly inside this folder.          |
| `recursive` | `true` / `false`                           | `false`   | Include all descendants of `folder`.                    |
| `type`      | `photo` / `video` / `audio` / `document` / `other` | all  | Filter by media type.                                   |
| `status`    | `present` / `missing` / `deleted`          | `present` | Filter by indexer status.                               |
| `sort`      | `name` / `size` / `mod_time`               | `name`    | Sort field.                                             |
| `order`     | `asc` / `desc`                             | `asc`     | Sort direction.                                         |
| `cursor`    | opaque                                     | –         | Page cursor returned as `next_cursor`.                  |
| `limit`     | 1–200                                      | 50        | Page size.                                              |

Examples:

```text
# First page of photos, newest first, 100 per page
GET /api/v1/libraries/{libraryID}/files?type=photo&sort=mod_time&order=desc&limit=100

# Everything under "vacation" including subfolders
GET /api/v1/libraries/{libraryID}/files?folder=vacation&recursive=true
```

### Folders

Directory contents are browsed with the folder tree and per-folder listing:

```
GET /api/v1/libraries/{libraryID}/folders?parent=vacation
```

```json
{ "folders": [ { "id": "…", "name": "…", "rel_path": "vacation/…", "file_count": 12 } ] }
```

Omit `parent` (or use `.`) for top-level folders. Combine with
`GET /files?folder=…` to render a directory browser: first list the child
folders, then list the files directly inside the folder.

## Getting a single file

```
GET /api/v1/libraries/{libraryID}/files/{fileID}
```

Returns `{ "file": { … } }` with the file object above. `404` when the id is
unknown.

## Metadata

```
GET /api/v1/libraries/{libraryID}/files/{fileID}/metadata
```

Returns extracted metadata recorded by the indexer (EXIF, dimensions, GPS,
camera info, duration):

```json
{
  "metadata": {
    "file_id": "a1b2c3d4e5f60718",
    "media_type": "photo",
    "mime_type": "image/jpeg",
    "width": 4032,
    "height": 3024,
    "duration_secs": null,
    "taken_at": "2026-06-14T17:30:04Z",
    "camera_make": "Apple",
    "camera_model": "iPhone 17 Pro",
    "latitude": 37.7749,
    "longitude": -122.4194,
    "has_thumbnail": true,
    "updated_at": "2026-06-15T08:12:33Z"
  }
}
```

Fields that are unknown are omitted (or `null` for numbers). When no metadata
has been extracted yet the response still succeeds with only `file_id`,
`media_type`, `mime_type`, and `has_thumbnail: false`.

## Thumbnails

```
GET /api/v1/libraries/{libraryID}/files/{fileID}/thumbnail
```

Serves a JPEG thumbnail (roughly 400 px on the long edge, quality ~82) sized
for list grids. The response has `Content-Type: image/jpeg`. Thumbnails are
generated on demand by the server, so the first request for a file may take
longer than subsequent ones; clients should cache aggressively.

- `404` when the source file has no thumbnail (non-visual media).
- Thumbnails for large archives may be slow the first time; always render
  with a placeholder and load the image lazily.

Returned `image/jpeg` bytes are safe to store to disk directly. Note that
when at-rest metadata encryption is enabled (Phase 13), thumbnails are
decrypted transparently by the server — clients never see ciphertext.

## Downloading (streaming)

```
GET /api/v1/libraries/{libraryID}/files/{fileID}/download
```

Streams the original file bytes with:

- `Content-Type` set to the file's stored MIME type,
- `Content-Disposition: attachment; filename="…"`,
- `Accept-Ranges: bytes` and standard `206 Partial Content` support via
  `http.ServeContent` semantics (`Range`, `If-Modified-Since`, …).

Range support is what makes video seeking work; a client can request
`Range: bytes=0-` to start streaming immediately without whole-file
resolution. Example curl download:

```text
curl -o beach.jpg \
  -b cookies.txt \
  http://host:8715/api/v1/libraries/{libraryID}/files/{fileID}/download
```

A `path` query parameter (`?path=vacation/beach.jpg`) is also accepted as an
alternative to `fileID`; the path is resolved against the index.

## Uploading

```
POST /api/v1/libraries/{libraryID}/files/upload
```

Multipart form upload. Two fields:

- `file` — the file part (required).
- `path` — optional destination path relative to the library root. When
  omitted the filename part is used. Subdirectories are created as needed.

Success is `201 Created` with `{ "file": { … } }` for the new index entry.

Concrete multipart example:

```text
POST /api/v1/libraries/{libraryID}/files/upload
Content-Type: multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW

------WebKitFormBoundary7MA4YWxkTrZu0gW
Content-Disposition: form-data; name="path"

vacation/beach.jpg
------WebKitFormBoundary7MA4YWxkTrZu0gW
Content-Disposition: form-data; name="file"; filename="beach.jpg"
Content-Type: image/jpeg

<binary bytes>
------WebKitFormBoundary7MA4YWxkTrZu0gW--
```

Behavior notes:

- Uploads are written to the filesystem and immediately indexed (the index
  entry appears in listings right away).
- Overwriting an existing path fails with `409 CONFLICT`.
- The request body is capped: the default maximum upload is 4 GiB
  (`CAIRN_MAX_UPLOAD_BYTES` overrides). Oversized uploads return
  `413 PAYLOAD_TOO_LARGE`. The multipart parser keeps 32 MiB in memory and
  spools the rest to a temporary file, so large uploads do not exhaust RAM.
- The destination parent folder capability `create` is required.

Mobile clients on flaky networks should upload in chunks themselves or
retry the whole request with backoff; the endpoint is not resumable today
(see the "future sync" notes in [mobile-development.md](mobile-development.md)).

## Rename, move, copy

```
POST /api/v1/libraries/{libraryID}/files/{fileID}/rename
{ "path": "vacation/beach.jpg", "new_name": "sunset.jpg" }
```

```json
{ "file": { "id": "…", "rel_path": "vacation/sunset.jpg", … } }
```

```
POST /api/v1/libraries/{libraryID}/files/{fileID}/move
{ "path": "vacation/beach.jpg", "new_path": "2026/beach.jpg" }
```

```
POST /api/v1/libraries/{libraryID}/files/{fileID}/copy
{ "path": "vacation/beach.jpg", "dest_path": "backup/beach.jpg" }
```

- `rename` requires `new_name` (a bare filename; it cannot contain `/`).
- `move` and `copy` take full destination paths; the destination parent
  folder is created as needed.
- `rename`/`move` return `{ "file": { … } }` for the updated entry; `copy`
  returns `201 Created` with the new entry.
- Collisions return `409 CONFLICT`.

## Trash and deletion

Deletion is **soft by default**: files go to the library trash, entries keep
their ids and metadata, and the operation is reversible.

```
DELETE /api/v1/libraries/{libraryID}/files/{fileID}
{ "path": "vacation/beach.jpg" }
```

`204 No Content`. The request body names the exact file path; the `fileID`
path segment selects the entry (this guards against acting on a different
file than the client believes it is editing).

```
POST /api/v1/libraries/{libraryID}/files/{fileID}/restore
```

Restores a trashed file to its original path. Returns `{ "file": { … } }`.
`409` when the file is not in trash or the original path is occupied.

```
GET /api/v1/libraries/{libraryID}/trash
```

```json
{ "files": [ { "id": "…", "rel_path": "…", "status": "deleted", … } ] }
```

```
DELETE /api/v1/libraries/{libraryID}/files/{fileID}/permanent
```

Irreversibly deletes the file and its index entry — `204 No Content`.
Permanent deletion requires the `delete` capability on the file; there is no
confirmation or undo, so clients should present an explicit confirmation UI.

## Favorites

```
POST   /api/v1/libraries/{libraryID}/files/{fileID}/favorite   → 204
DELETE /api/v1/libraries/{libraryID}/files/{fileID}/favorite   → 204
GET    /api/v1/libraries/{libraryID}/favorites                 → { "files": [ … ] }
```

Favoriting is idempotent for the client's practical purposes: adding an
already-favorited file returns `409`; removing a non-favorited file returns
`404`. Use the list endpoint plus the file ids to rebuild local state.

## Errors specific to media

Beyond the shared envelope ([api.md](api.md)):

| Code              | Status | Meaning                                                     |
| ----------------- | ------ | ----------------------------------------------------------- |
| `BAD_REQUEST`     | 400    | Invalid folder/filter, malformed multipart, missing `file` part, path traversal. |
| `NOT_FOUND`       | 404    | Unknown file/folder, or file not in favorites.              |
| `CONFLICT`        | 409    | Destination exists, file already in/not-in trash, already favorited. |
| `PAYLOAD_TOO_LARGE` | 413  | Upload exceeds the configured maximum.                      |
| `INTERNAL`        | 500    | Storage or database failure.                                |

An offline library returns `409 CONFLICT` ("Library is offline.") for every
content operation, because the backing filesystem may be a removable drive.

## Permissions

Every media operation is authorized against the shared capability model
(documented in [permissions.md](permissions.md)). In short: listing and
reading require `read`, downloads require `download`, uploads require
`create` on the destination folder, renames/moves/favorites/metadata require
`edit`, and delete/permanent-delete require `delete` on the file or folder
key. A session without the required capability gets `403 FORBIDDEN`.

## Also see

- [search.md](search.md) — full-text and filtered search across a library.
- [libraries.md](libraries.md) — library lifecycle; content endpoints need an
  online library.
- [permissions.md](permissions.md) — capability model and grant management.
- [sharing.md](sharing.md) — public share links for files and folders.
- [mobile-development.md](mobile-development.md) — client guidance built on
  these endpoints (streaming, caches, offline behavior).