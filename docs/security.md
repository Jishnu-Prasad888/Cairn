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
  resource-based authorization supersedes role gates throughout.

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
- Session/credential data is never written to logs; share tokens in public-share
  URLs are redacted from access and panic logs before they can be logged.
- Injection defenses are provided by parameterized queries and url-safe
  encoding (no raw user input concatenated into queries, paths, or HTML). SQL
  `LIKE` filters escape `%`, `_`, and `\` from path literals (Phase 16).
- CSRF defense relies on `SameSite=Lax` session cookies for cookie-authenticated
  state-changing requests, reinforced by an Origin check on non-GET methods
  (Phase 16).
- Secrets and keys are never committed (verified by rules and review).

## Hardening posture (Phase 16)

- Public auth endpoints are rate limited (per-IP token bucket + per-account
  failed-attempt lockout) and answer `429 RATE_LIMITED` with `Retry-After`
  rather than running the password hash.
- Unknown usernames burn the same argon2id budget as wrong passwords, so
  response time does not reveal whether an account exists.
- Every response carries browser hardening headers (`nosniff`, `DENY`
  framing, `no-referrer`, a `'self'` CSP, `same-origin` COOP).
- User-controlled image decoding is bounded: a shared safe-decoder rejects
  frames over 30 000 px per side or 50 megapixels before allocation.
- Uploads are capped (`CAIRN_MAX_UPLOAD_BYTES`, default 2 GiB) at both the
  HTTP and store layers; aborted uploads never strand temp files.
- Share-token path segments are redacted from logs (matching the
  authentication.md promise).

## Current posture

Phase 16 hardening is implemented: public auth endpoints are rate limited
(with failed-attempt lockout), origin-checked, and served with hardening
headers; unknown usernames cannot be timed; image decoding is bounded; uploads
are capped and atomic. The server still defaults to loopback binding and
should sit behind a reverse proxy and a trusted network.

## OS-level hardening checklist

- Run as an unprivileged user; `chown` only the data directory.
- Keep Cairn up to date; restart after upgrades (immutable cache headers force
  fresh assets automatically for browsers).
- Network shares (SMB/NFS) as libraries: mount read-only in the container if
  possible.