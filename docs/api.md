# API

Cairn exposes a REST/JSON API under `/api/v1/`. The API is a first-class
product: the entire frontend talks only to it, and future clients (React
Native, desktop, CLI, third-party integrations) are expected to be built
against it without reading Go source.

The machine-readable contract is [openapi.yaml](openapi.yaml). This document
describes conventions and anything that JSON Schema cannot express well.

Area-specific references:

- [libraries.md](libraries.md) — library lifecycle, probe, indexing.
- [media.md](media.md) — file listing, media types, metadata, thumbnails,
  upload/streaming download, trash, favorites.
- [search.md](search.md), [memories.md](memories.md), [markdown.md](markdown.md)
  — search, memories, and Markdown rendering.
- [permissions.md](permissions.md), [sharing.md](sharing.md) — authorization
  and public shares.
- [ml.md](ml.md) — local ML similarity and faces.
- [mobile-development.md](mobile-development.md) — client/native guidance,
  offline behavior, and upload/download practice.

## Base URL

```
http://<host>:8715/api/v1
```

Production deployments should put the API behind a TLS reverse proxy; see
[deployment.md](deployment.md).

## Content type

Requests and responses are JSON (`application/json`). Media streaming endpoints
(bulk upload/download, thumbnails) return binary bodies with appropriate
`Content-Type` headers and are documented individually.

## Error format

Every error response uses one envelope:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "No such API route: GET /api/v1/does-not-exist.",
    "details": {},
    "request_id": "b6f3329ae5..."
  }
}
```

- `code` is a stable machine-readable string. Use it in client logic, not the
  HTTP status alone.
- `message` is human-readable and may change; do not match on it.
- `details` is optional, additional structured context.
- `request_id` links the response to server logs; always include it in bug
  reports.

Stable codes and their usual HTTP status:

| Code                      | HTTP status |
| ------------------------- | ----------- |
| `BAD_REQUEST`             | 400         |
| `UNAUTHORIZED`            | 401         |
| `FORBIDDEN`               | 403         |
| `NOT_FOUND`               | 404         |
| `METHOD_NOT_ALLOWED`      | 405         |
| `CONFLICT`                | 409         |
| `RATE_LIMITED`            | 429         |
| `PAYLOAD_TOO_LARGE`       | 413         |
| `UNSUPPORTED_MEDIA_TYPE`  | 415         |
| `INTERNAL`                | 500         |
| `SERVICE_UNAVAILABLE`     | 503         |

Error messages never include stack traces, filesystem paths, or secrets.

## Request IDs

Every response carries an `X-Request-ID` header. Clients may send their own
well-formed `X-Request-ID` (letters, digits, `-`, `_`, `:`; max 128 chars) and
it will be echoed. The same value appears as `request_id` in errors.

## Pagination

List-oriented endpoints use **cursor pagination**:

```
GET /api/v1/libraries/{libraryID}/files?limit=50
```

```json
{ "files": [ ... ], "next_cursor": "...", "total": 1234 }
```

Responses return `next_cursor` and `total`. Pass `next_cursor` back as the
`cursor` query parameter for the next page; an empty `next_cursor` means the
last page. Cursors are opaque; clients must not parse or construct them. See
the OpenAPI schemas for each endpoint, and [media.md](media.md) for the file
listing parameters.

## Authentication

Authentication uses opaque session tokens delivered as an **HTTP-only cookie**
(`cairn_session`). This is the model browsers use most safely: JavaScript never
reads the cookie, and `SameSite=Lax` blocks most cross-site request forgery.
Native clients store the cookie their HTTP library manages and send it with
every request — no custom token plumbing.

- `POST /api/v1/auth/bootstrap` creates the initial admin account on a virgin
  server. Public, but only valid once (CONFLICT afterwards).
- `POST /api/v1/auth/login` starts a session. Every failure — unknown username,
  wrong password, disabled account — returns the same `UNAUTHORIZED` body.
  Public auth endpoints are rate limited: exceeding the sustained budget or the
  failed-attempt lockout returns `429 RATE_LIMITED` with a `Retry-After`
  header.
- `POST /api/v1/auth/logout` revokes the session and clears the cookie.
- `GET /api/v1/auth/status` reports bootstrap and authentication state so
  clients can route to setup/login/app on load.
- `GET /api/v1/auth/me` returns the current principal.
- User management (`GET|POST /api/v1/users`, session revocation) requires an
  admin account.

Other details:

- Only the **SHA-256 digest** of the session token is stored; a database leak
  never yields usable cookies.
- Sessions expire after 30 days and are pruned on startup and lazily on access.
- Passwords are hashed with **argon2id** (never a homegrown hash, never stored
  in plaintext) and never logged. Credentials and tokens are never logged.
- The cookie carries the `Secure` flag when the server observes TLS or
  `CAIRN_COOKIE_SECURE` is set for a TLS-terminating reverse proxy.
- The error body never reveals whether a login failed because of the username,
  the password, or the account state.

The OpenAPI security scheme is `cookieAuth`; protected operations advertise it
and public operations explicitly declare `security: [{}]`.

The design is described in [authentication.md](authentication.md). The initial
Admin/User roles are a convenience layer; resource-based authorization replaces
them in a later phase ([permissions.md](permissions.md)).

## Versioning

The version segment (`v1`) is part of the path to make breaking changes
explicit. Within `v1`, the `version` field in responses and additive fields are
preferred over breaking changes.

## Endpoints today

The full surface is 90+ operations. Tables below group them by area; the
authoritative contract (parameters, bodies, responses) is in
[openapi.yaml](openapi.yaml). `Auth` column: `none` = public, `session` = any
authenticated user, `admin` = admin role, `cap` = capability-checked
(see [permissions.md](permissions.md)).

### System and auth

| Method | Path                                  | Purpose                          | Auth |
| ------ | ------------------------------------- | -------------------------------- | ---- |
| GET    | `/health`                             | Liveness + dependency status     | none |
| GET    | `/ready`                              | Readiness gate (routable?)       | none |
| GET    | `/version`                            | Build metadata                   | none |
| GET    | `/metrics`                            | Prometheus-text metrics          | none |
| GET    | `/auth/status`                        | Bootstrap/auth state             | none |
| POST   | `/auth/bootstrap`                     | Create initial admin (once)      | none |
| POST   | `/auth/login`                         | Start a session                  | none |
| POST   | `/auth/logout`                        | Revoke the current session       | session |
| GET    | `/auth/me`                            | Current principal                | session |

### Users

| Method | Path                                  | Purpose                          | Auth |
| ------ | ------------------------------------- | -------------------------------- | ---- |
| GET    | `/users`                              | List accounts                    | admin |
| POST   | `/users`                              | Create an account                | admin |
| POST   | `/users/{id}/sessions/revoke`         | Invalidate a user's sessions     | admin |

### Libraries and indexing

| Method | Path                                  | Purpose                          | Auth |
| ------ | ------------------------------------- | -------------------------------- | ---- |
| GET    | `/libraries`                          | List libraries                   | admin |
| POST   | `/libraries`                          | Register a library               | admin |
| POST   | `/libraries/probe`                    | Pre-registration probe           | admin |
| GET    | `/libraries/{libraryID}`              | Library details + status         | session |
| POST   | `/libraries/{libraryID}/refresh`      | Rescan roots, reconcile          | admin |
| DELETE | `/libraries/{libraryID}`              | Unregister (never deletes data)  | admin |
| POST   | `/libraries/{libraryID}/index`        | Trigger an index job             | admin |
| GET    | `/libraries/{libraryID}/index/status` | Current index job state          | admin |

### Media, files, and folders

| Method | Path                                                        | Purpose                          | Auth |
| ------ | ----------------------------------------------------------- | -------------------------------- | ---- |
| GET    | `/libraries/{libraryID}/files`                              | Paged file listing               | cap  |
| GET    | `/libraries/{libraryID}/files/duplicates`                   | Duplicate groups by content hash | cap  |
| GET    | `/libraries/{libraryID}/files/{fileID}`                     | One file                         | cap  |
| GET    | `/libraries/{libraryID}/files/{fileID}/download`            | Stream original (Range)          | cap  |
| POST   | `/libraries/{libraryID}/files/upload`                       | Multipart upload                 | cap  |
| POST   | `/libraries/{libraryID}/files/{fileID}/rename`              | Rename a file                    | cap  |
| POST   | `/libraries/{libraryID}/files/{fileID}/move`                | Move a file                      | cap  |
| POST   | `/libraries/{libraryID}/files/{fileID}/copy`                | Copy a file                      | cap  |
| DELETE | `/libraries/{libraryID}/files/{fileID}`                     | Soft-delete (to trash)           | cap  |
| POST   | `/libraries/{libraryID}/files/{fileID}/restore`             | Restore from trash               | cap  |
| DELETE | `/libraries/{libraryID}/files/{fileID}/permanent`           | Permanent delete                 | cap  |
| GET    | `/libraries/{libraryID}/files/{fileID}/metadata`            | EXIF/GPS/dimensions metadata     | cap  |
| GET    | `/libraries/{libraryID}/files/{fileID}/thumbnail`           | JPEG thumbnail                   | cap  |
| GET    | `/libraries/{libraryID}/folders`                            | Child folders                    | cap  |
| GET    | `/libraries/{libraryID}/trash`                              | Trashed files                    | cap  |

### Favorites, tags, and albums

| Method | Path                                                        | Purpose                          | Auth |
| ------ | ----------------------------------------------------------- | -------------------------------- | ---- |
| POST   | `/libraries/{libraryID}/files/{fileID}/favorite`            | Favorite a file (204)            | cap  |
| DELETE | `/libraries/{libraryID}/files/{fileID}/favorite`            | Unfavorite a file (204)          | cap  |
| GET    | `/libraries/{libraryID}/favorites`                          | Favorited files                  | cap  |
| GET    | `/libraries/{libraryID}/tags`                               | List tags                        | cap  |
| POST   | `/libraries/{libraryID}/tags`                               | Create a tag                     | cap  |
| DELETE | `/libraries/{libraryID}/tags/{tagID}`                       | Delete a tag                     | cap  |
| GET    | `/libraries/{libraryID}/files/{fileID}/tags`                | A file's tags                    | cap  |
| POST   | `/libraries/{libraryID}/files/{fileID}/tags`                | Attach a tag to a file           | cap  |
| DELETE | `/libraries/{libraryID}/files/{fileID}/tags/{tagID}`        | Detach a tag                     | cap  |
| GET    | `/libraries/{libraryID}/albums`                             | List albums                      | cap  |
| POST   | `/libraries/{libraryID}/albums`                             | Create an album                  | cap  |
| DELETE | `/libraries/{libraryID}/albums/{albumID}`                   | Delete an album                  | cap  |
| GET    | `/libraries/{libraryID}/albums/{albumID}/files`             | Album contents                   | cap  |
| POST   | `/libraries/{libraryID}/albums/{albumID}/files/{fileID}`    | Add file to album (204)          | cap  |
| DELETE | `/libraries/{libraryID}/albums/{albumID}/files/{fileID}`    | Remove file from album (204)     | cap  |

### Search and memories

| Method | Path                                                        | Purpose                          | Auth |
| ------ | ----------------------------------------------------------- | -------------------------------- | ---- |
| GET    | `/libraries/{libraryID}/search`                             | FTS5 file search + filters       | cap  |
| GET    | `/libraries/{libraryID}/memories`                           | List / search memories           | session |
| POST   | `/libraries/{libraryID}/memories`                           | Create a memory                  | session |
| GET    | `/libraries/{libraryID}/memories/{memoryID}`                | Latest revision                  | session |
| PUT    | `/libraries/{libraryID}/memories/{memoryID}`                | Autosave (new revision)          | session |
| DELETE | `/libraries/{libraryID}/memories/{memoryID}`                | Soft delete                      | session |
| POST   | `/libraries/{libraryID}/memories/{memoryID}/restore`        | Restore                          | session |
| GET    | `/libraries/{libraryID}/memories/{memoryID}/versions`       | Revision list                    | session |
| GET    | `/libraries/{libraryID}/memories/{memoryID}/versions/{version}` | One revision                | session |
| GET    | `/libraries/{libraryID}/memories/{memoryID}/refs`           | Parsed wikilink references       | session |

### Permissions and shares (management)

| Method | Path                                                        | Purpose                          | Auth |
| ------ | ----------------------------------------------------------- | -------------------------------- | ---- |
| GET    | `/libraries/{libraryID}/permissions`                        | List grants                      | session |
| POST   | `/libraries/{libraryID}/permissions`                        | Create a grant                   | session |
| DELETE | `/libraries/{libraryID}/permissions/{grantID}`              | Revoke a grant                   | session |
| GET    | `/libraries/{libraryID}/shares`                             | List shares                      | session |
| POST   | `/libraries/{libraryID}/shares`                             | Create a share                   | session |
| DELETE | `/libraries/{libraryID}/shares/{shareID}`                   | Revoke a share                   | session |

### Public shares (token-authenticated)

| Method | Path                                                        | Purpose                          | Auth |
| ------ | ----------------------------------------------------------- | -------------------------------- | ---- |
| GET    | `/shares/{token}`                                           | Share metadata                   | token |
| GET    | `/shares/{token}/files`                                     | Share file listing               | token |
| GET    | `/shares/{token}/files/{fileID}`                            | One shared file                  | token |
| GET    | `/shares/{token}/files/{fileID}/download`                   | Stream shared file               | token |
| POST   | `/shares/{token}/authenticate`                              | Unlock a password-protected share | token |

### Backups (admin)

| Method | Path                                  | Purpose                          | Auth |
| ------ | ------------------------------------- | -------------------------------- | ---- |
| POST   | `/backups`                            | Run a backup                     | admin |
| GET    | `/backups`                            | List backups                     | admin |
| GET    | `/backups/{id}`                       | Backup details                   | admin |
| POST   | `/backups/{id}/verify`                | Verify a backup                  | admin |
| POST   | `/backups/{id}/restore`               | Restore from a backup            | admin |

### Local ML (opt-in build)

Similarity, face recognition, and people endpoints under
`/libraries/{libraryID}/ml*`, `/people*`, and `/faces*` (plus the
`/files/{fileID}/similar` route) are documented in
[`ml.md`](ml.md); `/search` is documented in [`search.md`](search.md).

## Request/response examples

### Health

```text
GET /api/v1/health
```

```json
{ "status": "ok", "database": "ok" }
```

When the database is unreachable the response is still HTTP 200 so that probes
can distinguish "server alive but degraded" from "server gone", with
`"status": "degraded"`.

### Readiness

```text
GET /api/v1/ready
```

```json
{ "status": "ready", "database": "ok" }
```

Unlike `/health` (liveness), `/ready` returns HTTP 200 only when traffic should
be routed to this instance: startup has completed and the database answers
pings. It returns 503 with `"status": "unavailable"` while starting, when the
database is unreachable, or once graceful shutdown begins (so load balancers
and orchestrators drain connections to remaining instances).

### Metrics

```text
GET /api/v1/metrics
```

```text
# HELP cairn_http_requests_total Total HTTP requests by method and status code.
# TYPE cairn_http_requests_total counter
cairn_http_requests_total{method="GET",status="200"} 42
# HELP cairn_http_request_duration_seconds HTTP request latency.
# TYPE cairn_http_request_duration_seconds histogram
cairn_http_request_duration_seconds_bucket{le="0.25"} 41
```

Prometheus text exposition format, with no third-party dependencies. Exposes
request counters (method + status), a latency histogram, in-flight requests,
process uptime, and Go runtime gauges. See [installation.md](installation.md)
for scraping notes.

### Login lifecycle

```text
POST /api/v1/auth/login
{"username": "admin", "password": "correct-horse-battery"}
```

```text
HTTP/1.1 200 OK
Set-Cookie: cairn_session=…; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000
```

```json
{ "user": { "id": "279674acccc95b5c", "username": "admin", "role": "admin", "created_at": "2026-09-22T15:27:17.365651564Z" } }
```

```text
POST /api/v1/auth/login
{"username": "admin", "password": "wrong"}
```

```json
{ "error": { "code": "UNAUTHORIZED", "message": "Invalid username or password.", "request_id": "..." } }
```

### Unknown route

```text
GET /api/v1/does-not-exist
```

```json
{ "error": { "code": "NOT_FOUND", "message": "No such API route: GET /api/v1/does-not-exist.", "request_id": "..." } }
```