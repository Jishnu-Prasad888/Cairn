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

Authentication is not yet implemented (Phase 1). The API is currently
unauthenticated and binds to `127.0.0.1:8715` by default. When sessions arrive,
they will use HTTP-only cookies; the OpenAPI security schemes will be updated
accordingly. [authentication.md](authentication.md) describes the design.

## Versioning

The version segment (`v1`) is part of the path to make breaking changes
explicit. Within `v1`, the `version` field in responses and additive fields are
preferred over breaking changes.

## Endpoints today

| Method | Path                   | Purpose                          |
| ------ | ---------------------- | -------------------------------- |
| GET    | `/api/v1/health`       | Liveness + dependency status     |
| GET    | `/api/v1/version`      | Build metadata                   |

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

### Unknown route

```text
GET /api/v1/does-not-exist
```

```json
{ "error": { "code": "NOT_FOUND", "message": "No such API route: GET /api/v1/does-not-exist.", "request_id": "..." } }
```