# Authentication

Implemented in Phase 1: user accounts, sessions, roles, and audit logging.
Resource-based authorization is deliberately out of scope ([permissions.md](permissions.md)).

## Scope

- User accounts with argon2id password hashing (never a homegrown hash).
- Sessions: opaque tokens delivered as an HTTP-only cookie, with login, logout,
  current-user, and revocation endpoint.
- Initial `Admin`/`User` roles as a convenience layer; roles never replace the
  resource-based permission model.
- Audit logging of authentication events.

## Passwords

- Hashed with **argon2id** (RFC 9106 parameters: m=65536 KiB, t=3, p=2, key
  length 32, 16-byte random salt).
- Hashes use the PHC string format: `$argon2id$v=19$m=65536,t=3,p=2$<salt>$<hash>`.
- Verified with constant-time comparison. Validation limits username to 64 bytes
  and password to 8–1024 bytes.
- Passwords never leave the server except as hashes; they are never logged.

## Sessions

- A session token is 32 random bytes (`crypto/rand`), base64url-encoded.
- Only the **SHA-256 digest** of the token is stored in `sessions`; a database
  leak never yields usable credentials.
- The token travels as the `cairn_session` cookie: `HttpOnly`, `SameSite=Lax`,
  with `Secure` added when TLS is observed or `CAIRN_COOKIE_SECURE` is set.
- TTL is **30 days**. Expired and revoked sessions are deleted; the server
  prunes expired sessions at startup and opportunistically when a stale session
  is presented.
- Logout deletes the session row server-side and clears the cookie.

### Endpoints

| Method | Path                                 | Purpose                      | Auth    |
| ------ | ------------------------------------ | ---------------------------- | ------- |
| GET    | `/api/v1/auth/status`                | Bootstrap/auth state          | none    |
| POST   | `/api/v1/auth/bootstrap`             | Create initial admin          | none    |
| POST   | `/api/v1/auth/login`                 | Start a session               | none    |
| POST   | `/api/v1/auth/logout`                | Revoke current session        | session |
| GET    | `/api/v1/auth/me`                    | Current principal             | session |
| GET    | `/api/v1/users`                      | List accounts                 | admin   |
| POST   | `/api/v1/users`                      | Create account                | admin   |
| POST   | `/api/v1/users/{id}/sessions/revoke` | Invalidate a user's sessions  | admin   |

Full contracts live in [openapi.yaml](openapi.yaml); conventions in [api.md](api.md).

## Roles

Users carry one of two roles: `admin` or `user`. The only sanctioned role gate
today is the single middleware decision in `internal/httpapi/auth.go`
(`withAuth` + `allowAdmin`/`allowAny`). Resource-based authorization replaces
this at the handler level; the role column remains as the initial
convenience layer ([permissions.md](permissions.md), ADR-0005).

## Bootstrap

A virgin server has no accounts. `POST /api/v1/auth/bootstrap` creates the
single initial `admin` and starts its session. Any further call — regardless of
credential validity — returns `409 CONFLICT`, so a provisioned server reveals
nothing via this endpoint.

## Failure behavior

Every login failure surfaces the same `UNAUTHORIZED` error without indicating
whether the username, password, or account state caused it. Invalid inputs are
rejected earlier with `BAD_REQUEST` where the failure is provably structural
(e.g. malformed JSON, over-long payload).

## Audit logging

Security-relevant events are recorded in `audit_log`:

- `auth.bootstrap_completed`
- `auth.login_succeeded` / `auth.login_failed`
- `auth.logout`
- `auth.session_revoked`
- `auth.user_created` (and future user mutations)

Each record carries actor, target, IP address, user agent, and structured
metadata (never credentials or tokens). See `internal/audit`.

## Privacy

Credentials, session tokens, and share tokens are never logged. Audit metadata
is deliberately non-sensitive structured JSON.

## Deferred to later phases

- Rate limiting on login (Phase 16 hardening).
- CSRF hardening beyond SameSite=Lax (Phase 16 hardening).
- Two-factor authentication and password reset flows.
- Resource-based authorization ([permissions.md](permissions.md)).