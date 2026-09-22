# Security

## Model

Cairn is personal software with a browser frontend. It must be:

- safe to expose only in a trusted network, and
- configured and operated safely by non-experts behind a reverse proxy.

## Binding

- Default bind is `127.0.0.1:8715` (loopback only).
- Do not expose a public interface until authentication ships (Phase 1).
- Terminate TLS at a reverse proxy (Caddy, nginx, Traefik).

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
- Session/creditential data is never written to logs.
- Injection defenses are provided by parameterized queries and url-safe
  encoding (no raw user input concatenated into queries, paths, or HTML).
- CSRF protection for cookie-authenticated state-changing requests (Phase 1+).
- Secrets and keys are never committed (verified by rules and review).

## Current posture

In Phase 0 there is no authentication, no upload, and no external database. The
attack surface is limited to read-only health/version endpoints; the binding
still defaults to loopback.

## OS-level hardening checklist

- Run as an unprivileged user; `chown` only the data directory.
- Keep Cairn up to date; restart after upgrades (immutable cache headers force
  fresh assets automatically for browsers).
- Network shares (SMB/NFS) as libraries: mount read-only in the container if
  possible.