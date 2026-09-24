# Mobile development

Cairn's API is a first-class product: any client — web, desktop, CLI, or a
React Native app — can be built entirely against the documented HTTP contract
without reading Go source. This guide is written for a mobile (React Native /
Flutter / native) developer. The authoritative references are
[api.md](api.md) (conventions), [openapi.yaml](openapi.yaml) (machine-readable
contract), and the per-area docs ([media.md](media.md), [libraries.md](libraries.md),
[search.md](search.md), [memories.md](memories.md), [permissions.md](permissions.md),
[sharing.md](sharing.md)).

## API base URL

```
http://<host>:8715/api/v1
```

- The port is configurable (`CAIRN_PORT`); `8715` is the default.
- Production deployments should front the API with a TLS reverse proxy, in
  which case the base URL is `https://<host>/api/v1`. See
  [deployment.md](deployment.md).
- Never hard-code the scheme/host in the app; make the base URL a setting the
  user edits in-app (many home users run Cairn on a LAN IP, a Raspberry Pi, or
  a Tailscale hostname). Support both `http://` (LAN) and `https://` (with the
  proxy) and remember to permit the certificate for non-public hosts.
- The web UI is the reference client and calls the same endpoints; you can
  verify any workflow against it as a fallback.

## Authentication flow

Authentication is session-based with an opaque token delivered as an HTTP-only
cookie. There is no bearer-token plumbing.

1. `GET /api/v1/auth/status` — public. Returns `{ "bootstrap": bool,
   "authenticated": bool, ... }`. On app launch, call this first to decide
   where to route:

   - `bootstrap: false` → the server has no admin yet; show setup, then
     `POST /api/v1/auth/bootstrap`.
   - `bootstrap: true` and `authenticated: false` → show login.
   - `authenticated: true` → the stored session is still valid; go to the app
     home.

2. `POST /api/v1/auth/login` with `{ "username", "password" }` (JSON body).

   ```text
   POST /api/v1/auth/login
   Content-Type: application/json

   {"username": "admin", "password": "correct-horse-battery"}
   ```

   ```text
   HTTP/1.1 200 OK
   Set-Cookie: cairn_session=…; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000

   { "user": { "id": "279674acccc95b5c", "username": "admin", "role": "admin", "created_at": "..." } }
   ```

3. `POST /api/v1/auth/logout` — revokes the session and clears the cookie.

Notes:

- Every failed login (unknown user, wrong password, disabled account) returns
  the same `401 UNAUTHORIZED` body; do not present different error text to
  attackers.
- Login attempts are rate limited; sustained abuse or too many failures in a
  row returns `429 RATE_LIMITED` with a `Retry-After` header.
- User provisioning (`GET|POST /api/v1/users`) is admin-only and is normally
  performed in the web UI, not the mobile app.

### Bootstrap

On a virgin server:

```text
POST /api/v1/auth/bootstrap
{"username": "admin", "password": "…"}
```

Valid exactly once; afterwards it returns `409 CONFLICT`. If the app shows a
"create account" screen, gate it on `auth/status → bootstrap == false`.

## Session handling

On mobile there is no browser cookie jar, so the session cookie must be
handled explicitly:

- Use your HTTP library's cookie store (e.g.
  `URLSession.shared.configuration.httpCookieStorage` on iOS, `OkHttpClient`
  cookie jar on Android) and let it persist `cairn_session` securely — it will
  then be sent automatically on every request, mirroring browser behavior.
- Send and store the cookie only over TLS in production. On plain HTTP LAN
  connections the cookie has no `Secure` flag; treat the connection as trusted
  (private network) and do not ship a hard-coded password.
- The session cookie is `SameSite=Lax` and `HttpOnly`; the server stores only
  the SHA-256 digest of the token.
- Sessions expire after 30 days (`Max-Age=2592000`); when a request comes back
  `401 UNAUTHORIZED` with a stale session, clear local state and route to
  login rather than erroring hard.
- Do not store the password; persist only the cookie (or nothing and require
  re-login) in Keychain/Keystore.
- Every response also carries an `X-Request-ID` header; use your own
  `X-Request-ID` (letters, digits, `-`, `_`, `:`; max 128 chars) and it is
  echoed — invaluable for support when offline sync is involved.

## API versioning

- The version lives in the URL path (`/api/v1/...`); a future breaking change
  moves to `v2`, so old clients keep working against old deployments.
- Within `v1`, the server prefers additive changes (new optional fields, new
  endpoints) over breaking ones.

**Client rules:**

- Parse JSON responses tolerantly: unknown fields are safe to ignore; never
  fail on an unexpected extra key.
- Treat documented fields you do not use as opaque; re-send them unchanged
  when round-tripping objects you did not author.
- Compile against the OpenAPI document, and keep your generated types
  independent from the server's Go structs.

## Pagination

List endpoints use **cursor pagination** — never page numbers.

```
GET /api/v1/libraries/{libraryID}/files?limit=50
```

```json
{ "files": [ … ], "next_cursor": "…", "total": 1234 }
```

- Take `next_cursor` and pass it as `cursor` for the next request.
- `next_cursor` empty means the last page.
- Cursors are opaque strings; do not parse, decorate, or cache-bust them —
  they already encode the sort that produced them. Change the sort, restart
  from the beginning.
- `total` is approximate (counted without pagination); treat it as a guide for
  progress bars only.
- Default page size is 50; `limit` is clamped to 1–200. Pick a limit that
  matches how many rows your list renders at once; for media grids 100–200 is
  usually right, and be prepared to page.
- Apply the same cursor contract to `/search` and to memory listings.

## Search

```
GET /api/v1/libraries/{libraryID}/search?q=vacation+beach&type=photo&limit=100
```

Response is the same paged envelope as media listings:

```json
{ "files": [ … ], "next_cursor": "…", "total": 42 }
```

Filters (all optional, combinable): `q` (FTS5 expression), `type`, `folder`,
`tag` (name), `album` (id), `person` (id), `min_size`, `max_size`, `from`/
`to` (RFC3339 `mod_time` bounds), `cursor`, `limit`.

- Query syntax supports `AND`, `OR`, `NOT`/`-`, quoted phrases, and implicit
  prefix matching; malformed queries return `400 BAD_REQUEST` — surface the
  `error.message` to the user instead of guessing.
- Empty `q` = browse-all mode; combine with filters for a rich filter UI
  without a search box.
- Memory search is `GET /libraries/{libraryID}/memories?q=...` with the same
  parser.
- Face/person search: `person` filters to faces assigned to a person
  (Phase 15, opt-in); a `404`/empty result is expected when ML is disabled.

See [search.md](search.md) for the full syntax and filter table.

## Media listing

```
GET /api/v1/libraries/{libraryID}/files?type=photo&recursive=true&sort=mod_time&order=desc&limit=100
```

Parameters (see [media.md](media.md)): `folder`, `recursive`, `type`, `status`,
`sort` (`name|size|mod_time`), `order` (`asc|desc`), `cursor`, `limit`.

Recommended patterns for a photo/video app:

- **Library/album home grid:** `type=photo&recursive=true&sort=mod_time&order=desc`.
- **Folder browser:** `GET /folders?parent=…` for child folders, then
  `GET /files?folder=…` (non-recursive) for the folder's own files.
- **"All" view:** omit the folder filter and use `recursive=true`.
- Each file object has `id`, `rel_path`, `size_bytes`, `mod_time`, `media_type`,
  `mime_type`, `status`, and `content_hash` (when computed). Use `id` as the
  stable key for React Native lists (never index).
- Filter `status` to `present` normally; `missing`/`deleted` are for the
  administration UI.

## Media streaming

Streaming media (video playback, audio) uses the download endpoint's HTTP
Range support:

```
GET /api/v1/libraries/{libraryID}/files/{fileID}/download
```

- Server advertises `Accept-Ranges: bytes` and serves `206 Partial Content`
  for `Range` requests — this is exactly what `expo-video` / `AVPlayer` /
  `ExoPlayer` need for seeking.
- Point the player at the download URL with your session cookie attached
  (cookie jar) and it streams without whole-file download.
- `curl -I` to check sizes: the response includes `Content-Length` (or
  `Content-Range` for range responses).

**Thumbnails / pre-roll previews:** request `.../files/{fileID}/thumbnail`
(JPEG, ~400 px) for grid cells and `.../download` only when a cell is about to
be played. Never preload full videos into memory.

## Uploads

```
POST /api/v1/libraries/{libraryID}/files/upload
Content-Type: multipart/form-data; boundary=…WebKitFormBoundary…

------…WebKitFormBoundary…
Content-Disposition: form-data; name="path"

camera_roll/IMG_0042.jpg
------…WebKitFormBoundary…
Content-Disposition: form-data; name="file"; filename="IMG_0042.jpg"
Content-Type: image/jpeg

<binary>
------…WebKitFormBoundary…--
```

- `file` part required; `path` optional (defaults to the filename part).
- Success → `201 Created` with `{ "file": { … } }`.
- Max upload size is configurable server-side (`CAIRN_MAX_UPLOAD_BYTES`),
  default generous; oversized bodies → `413 PAYLOAD_TOO_LARGE`.
- The endpoint is not resumable: a dropped connection means retrying the whole
  request. For a phone camera roll (large HEIC/MP4 files) prefer:

  1. queue uploads and retry with exponential backoff (see Retries);
  2. suggest Wi-Fi for very large batches, or upload during charging;
  3. keep the app in the foreground or use a platform background task —
     the API itself is a plain POST and benefits from nothing server-side yet
     (future sync work will add resumable, chunked upload).

- Uploads from the gallery must preserve original filename and chosen folder
  via the `path` field.

## Downloads

Use the download endpoint to save originals:

```
GET /api/v1/libraries/{libraryID}/files/{fileID}/download
```

- Response headers: `Content-Type` = stored MIME, `Content-Disposition:
  attachment; filename="…"`, `Accept-Ranges: bytes`.
- `?path=vacation/beach.jpg` also works instead of `fileID`.
- For offline viewing, download the original plus its thumbnail and cache both
  keyed by `fileID`; keep at least the thumbnail for grid rendering when
  offline.
- Respect the server's rate limits: a media library can be many gigabytes, so
  batch downloads with concurrency 2–3 and honor 429 backoff.

## Thumbnails

```
GET /api/v1/libraries/{libraryID}/files/{fileID}/thumbnail
```

- `image/jpeg`, roughly 400 px long-edge, quality ~82 — sized for grid cells;
  do not scale it up client-side.
- First request per file may trigger on-demand generation (slower); cache
  thumbnails persistently (e.g. in the filesystem cache directory keyed by
  `fileID`) so later sessions are instant.
- `404` for files with no visual thumbnail — fall back to a file-type icon.
- Load thumbnails lazily in list cells; a 200-item grid should only fetch the
  visible range.

## Permissions

Cairn is capability-based (see [permissions.md](permissions.md)); the mobile
app should treat permissions as server-enforced and adapt its UI:

- Every request is authorized server-side. Denials are `403 FORBIDDEN` with a
  structured error; show the message and hide/disable the offending action
  rather than retrying blindly.
- Users can be granted or denied per library and per folder subtree, so the
  same library may be partially visible. Listings already respect this: a
  folder you cannot read simply does not appear; you do not need to pre-filter
  client-side.
- Capabilities map to actions:

  | Capability | App action                                        |
  | ---------- | ------------------------------------------------- |
  | `read`     | Listing, metadata, thumbnails, search within the scope |
  | `download` | Streaming and saving originals                    |
  | `create`   | Upload and copy into a folder                     |
  | `edit`     | Rename, move, favorite, edit metadata             |
  | `delete`   | Move to trash / permanent delete                  |

- Grant management (`/libraries/{libraryID}/permissions`) is a first-class API
  but typically an admin/web concern; a mobile app for admins can call it
  directly.

## Sharing

Public shares let non-authenticated users get limited access via a token
([sharing.md](sharing.md)):

- `GET /api/v1/shares/{token}` → share metadata (name, folder, read-only?).
- `GET /api/v1/shares/{token}/files` → file listing.
- `GET /api/v1/shares/{token}/files/{fileID}` and `.../download` → fetch
  content.
- `POST /api/v1/shares/{token}/authenticate` → if the share is
  password-protected, authenticate once and receive the session cookie used
  for subsequent share requests.

Share endpoints are public but token-scoped; a valid token with a wrong share
password still gated. For your mobile app:

- Sharing a library/folder to a friend normally means generating the token in
  the authenticated app and messaging the link `https://host/#/share/<token>`
  — the receiving side opens the web UI. Rendering share content natively is
  possible with the endpoints above plus the password flow.

## Memories and Markdown

Memories are Markdown documents inside a library
([memories.md](memories.md)):

- List/create/read/update/soft-delete/restore under
  `/api/v1/libraries/{libraryID}/memories[...]`.
- Update is `PUT` and **versioned**: every save appends a revision; the latest
  is the current content. Versions are listed/fetched at
  `.../memories/{memoryID}/versions` and `.../versions/{version}`. Autosave in
  a mobile editor maps perfectly onto this: save on debounce, show a restoring
  picker from the versions list.
- Bodies are Markdown with `[[type:id]]` wikilinks (`media`, `memory`,
  `album`, `person`, `tag`) — render them client-side with the object id and
  resolve to screen navigation; `GET .../memories/{memoryID}/refs` lists
  parsed references for "references in" navigation.
- Render Markdown locally with a standard CommonMark renderer; no server-side
  rendering exists for previews.

## Error handling

Every error uses one envelope ([api.md](api.md)):

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

Client rules:

- Branch on `code`, never on `message` text, and never on HTTP status alone
  (several codes share a status).
- Stable codes include `BAD_REQUEST` (400), `UNAUTHORIZED` (401),
  `FORBIDDEN` (403), `NOT_FOUND` (404), `METHOD_NOT_ALLOWED` (405),
  `CONFLICT` (409), `PAYLOAD_TOO_LARGE` (413), `UNSUPPORTED_MEDIA_TYPE` (415),
  `RATE_LIMITED` (429), `INTERNAL` (500), `SERVICE_UNAVAILABLE` (503).
- Show `message` to the user for actionable errors; always log/include
  `request_id` in bug reports.
- `401` → drop local session, route to login. `403` → hide the action.
  `409` → the operation conflicts with server state; refresh the affected list
  item (e.g. a file already deleted elsewhere — remove it locally).
  `429` → respect `Retry-After` and back off globally, not just per-request.
- Timeouts and dropped connections are not server errors: no `error` envelope
  will arrive, so distinguish "request failed" from "server said no" in the UI
  copy.

## Retries

Cairn's endpoints are nearly all idempotent-or-safe to retry, but read the
contract for each one:

- **Safe to retry blindly:** list/get/search/download/metadata/thumbnail
  (GETs), and idempotent state ops such as `restore`, `favorite`/unfavorite,
  add/remove album files (repeatable; duplicate adds return 409, treat 409 as
  "already done" for toggle-style UIs where appropriate).
- **Retry with caution:** `upload` (POST with a body). Do **not** blindly
  re-POST a multipart body after a timeout — the first attempt may have
  succeeded server-side and the second will `409` on the same path. Best
  behavior: retry once or twice with backoff, then verify by looking up the
  target path via `GET /files?folder=…&q=<name>`; or generate a new unique
  `path` per attempt and dedupe later.
- **Universal backoff policy:** start at ~1s, double up to ~30s, add jitter,
  cap total attempts (~4–5), and surface "queued, will retry" rather than
  blocking the UI.
- Honor `Retry-After` on 429 responses above all other backoff scheduling.

## Offline behavior

The API is online-only: there is no server-side offline queue, push, or
sync protocol yet. "Offline" today means **client-side caching**:

- **Immutable, cacheable:** thumbnails (key by `fileID`), share metadata,
  memory **versions** (immutable revisions — safe to cache; the *latest* body
  is not).
- **Revalidate on reconnect:** file listings (cache the last page, re-fetch on
  foreground), album membership, favorites, and search results.
- **Queue and retry:** uploads and edits form an outbox; flush it with the
  backoff policy above when connectivity returns. Store the outbox encrypted
  in the app sandbox.
- **Read-mostly UX that works with caches:** show the last-known grid,
  thumbnails from cache, and a "you're offline" banner; attempt reads against
  the API in the background and reconcile when it succeeds.
- Do not fabricate data: never show a trashed/edited state you only guessed.
  Keep the server as the source of truth for `status`, `mod_time`, and trash.

## Future sync considerations

Sync (as opposed to plain caching) is planned, not shipped. Design your app
so it can adopt a sync protocol later without an architecture change:

- Key every entity by stable, server-issued ids (`fileID`, `memoryID`,
  `albumID`, `tagID`); local secondary keys (paths) may change.
- Treat server state as append-only-friendly: favorites, tags, and memories
  are small deltas — ideal future sync atoms.
- Keep uploads grouped and resumable at the client layer (chunked, ordered)
  so a future resumable endpoint needs no client rewrite.
- Record lightweight local change logs ("added favorite X at T", "edited
  memory Y at T") so the future sync can merge by entity + timestamp.
- Content hashes (`content_hash`) on file objects let a future client dedupe
  and verify uploads; store them persistently today.

## Checklist for a first mobile slice

1. Base URL setting + `auth/status` routing (bootstrap/login/home).
2. Cookie-jar login; `401` → re-login.
3. Paged media grid with thumbnails; `next_cursor` paging.
4. Single-file view + download/stream with Range.
5. Upload from gallery with `path`; 413/409 surfaced.
6. Error envelope mapping + `request_id` in logging.
7. Offline thumbnail cache + upload outbox with backoff.
8. Search screen (filters + query syntax), memories editor with autosave.