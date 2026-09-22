# Security

## Model

Cairn is personal software with a browser frontend. It must be:

- safe to expose only in a trusted network, and
- configured and operated safely by non-experts behind a reverse proxy.

## Binding

- Default bind is `127.0.0.1:8715` (loopback only).
- Terminate TLS at a reverse proxy (Caddy, nginx, Traefik).

## Authentication and sessions

- Passwords are hashed with **argon2id** and compared in constant time; they are
  never stored or logged in plaintext.
- Sessions use opaque random tokens; only their SHA-256 digest is stored.
- The `cairn_session` cookie is `HttpOnly` and `SameSite=Lax`. The `Secure` flag
  is added when the server observes TLS or `CAIRN_COOKIE_SECURE` is set (for a
  TLS-terminating reverse proxy).
- Login failures all return the same generic `UNAUTHORIZED` so responses never
  reveal whether a username, password, or account state caused the failure.
- `admin`-only endpoints are gated in one place (`withAuth`/`allowAdmin`);
  Phase 9 supersedes role gates with resource-based authorization.

See [authentication.md](authentication.md) for the full design.

## Handling user content safely

Every subsystem that deals with filesystem paths, user-uploaded media, or
downloads:

- resolves real paths,
- prevents path traversal,
- never trusts user-supplied paths for writes,
- uses explicit allowlists, disallowing `.cairn/` and control characters,
- protects against HTML/svg injection: issues may bypass browsers' MIME
  sniffing rules; `Content-Disposition` and safe content types are enforced on
  streams.

## Defensive correctness

- All unserialized bytes passing through the API layer are treated as data, not
  markup.
- Session/credential data is never written to logs.
- Injection defenses are provided by parameterized queries and url-safe
  encoding (no raw user input concatenated into queries, paths, or HTML).
- CSRF defense relies on `SameSite=Lax` session cookies for cookie-authenticated
  state-changing requests (Phase 1); further hardening is planned (Phase 16).
- Secrets and keys are never committed (verified by rules and review).

## Current posture

Phase 1 adds authentication: users, argon2id password hashes, 30-day opaque
session cookies (digests stored, not tokens), and audit logging. The binding
still defaults to loopback, the request body is capped at 1 MiB, and login
failures are deliberately uninformative. Rate limiting and advanced CSRF
defenses are promised in the hardening phase (Phase 16); keep the server behind
a reverse proxy and a trusted network until then.

## OS-level hardening checklist

- Run as an unprivileged user; `chown` only the data directory.
- Keep Cairn up to date; restart after upgrades (immutable cache headers force
  fresh assets automatically for browsers).
- Network shares (SMB/NFS) as libraries: mount read-only in the container if
  possible.