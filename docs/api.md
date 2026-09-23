# API

Cairn exposes a REST/JSON API under `/api/v1/`. The API is a first-class
product: the entire frontend talks only to it, and future clients (React
Native, desktop, CLI, third-party integrations) are expected to be built
against it without reading Go source.

The machine-readable contract is [openapi.yaml](openapi.yaml). This document
describes conventions and anything that JSON Schema cannot express well.

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

List-oriented endpoints (added in later phases) use **cursor pagination**:

```
GET /api/v1/media?limit=50&after=<cursor>
```

Responses return `next_cursor` and `has_more`. Cursors are opaque; clients must
not parse or construct them. See the OpenAPI schemas for each endpoint.

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

| Method | Path                                  | Purpose                          | Auth |
| ------ | ------------------------------------- | -------------------------------- | ---- |
| GET    | `/api/v1/health`                      | Liveness + dependency status     | none |
| GET    | `/api/v1/version`                     | Build metadata                   | none |
| GET    | `/api/v1/auth/status`                 | Bootstrap/auth state             | none |
| POST   | `/api/v1/auth/bootstrap`              | Create initial admin (once)      | none |
| POST   | `/api/v1/auth/login`                  | Start a session                  | none |
| POST   | `/api/v1/auth/logout`                 | Revoke the current session       | session |
| GET    | `/api/v1/auth/me`                     | Current principal                | session |
| GET    | `/api/v1/users`                       | List accounts                    | admin |
| POST   | `/api/v1/users`                       | Create an account                | admin |
| POST   | `/api/v1/users/{id}/sessions/revoke`  | Invalidate a user's sessions     | admin |

Local ML endpoints (`/libraries/{id}/ml/...`, similarity + face recognition,
and the `/people` + face/assignment routes) are documented in
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