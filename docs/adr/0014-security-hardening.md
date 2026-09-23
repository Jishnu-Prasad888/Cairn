# ADR-0014 — Security hardening policy

Status: accepted

## Context

Phase 16 conducted a defensive review of the server surface. Most subsystems
were already sound (parameterized SQL, centralized capability enforcement,
argon2id password hashing with constant-time compare, hashed opaque
session/share tokens, a shared path sanitizer, disciplined audit logging). The
review found a handful of exploitable gaps: unthrottled public auth endpoints,
share tokens leaking to the access log, unbounded uploads, image decode bombs,
no security headers/CSRF defense-in-depth, and no brute-force lockout.

## Decision

1. **Public auth endpoints get rate limiting + lockout.** Per-IP token
   buckets with per-username failed-attempt lockout, in-process (no external
   store), applied to `/auth/login`, `/auth/bootstrap`, and
   `/shares/{token}/authenticate`. Exceeding limits returns HTTP 429 with the
   existing `RATE_LIMITED` code. In-process state is a single-instance
   default; this does not replace (and is compatible with) upstream
   rate limiting behind a proxy.
2. **Share tokens never appear in logs.** The access-log and panic-recovery
   middleware redact the `/shares/{token}/` path segment. This makes the
   existing "share tokens are never logged" documentation true.
3. **Baseline security headers and Origin checks.** Every response sets
   `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and
   `Referrer-Policy: no-referrer` plus a `'self'`-only CSP. Non-GET methods
   with an `Origin` header must match the request host (or an explicit
   allow-list) or get 403. `SameSite=Lax` on the session cookie remains the
   primary CSRF defense for cookie-carrying requests.
4. **Decoding attacker-controlled images is bounded.** A shared
   `safeimage.Decode` enforces `50 MP` pixel and `30 000 px` per-dimension
   caps (via `image.DecodeConfig` pre-scan) at every decode site before
   allocation.
5. **Uploads are capped and atomic.** A configurable `CAIRN_MAX_UPLOAD_BYTES`
   (default 2 GiB) caps multipart bodies with `http.MaxBytesReader` (→ 413)
   and the store stream with `io.LimitReader`; temp files are removed
   unconditionally on abort.

## Deferred (tracked follow-ups)

- Per-file authorization filtering in authenticated aggregate listings
  (recursive listings, search, trash, favorites) — requires reworking those
  queries to filter rows by capability, mirroring the share listing.
- User-scoped favorites (`user_id` migration + backfill).
- Symlink containment for library roots (scanner `ModeSymlink` skip and
  `EvalSymlinks` on open) — interacts with external-drive workflows.
- Session hardening: binding/rotation, `__Host-` prefix, `Secure` behind
  TLS-terminating proxies via `X-Forwarded-Proto`.
- Password lifecycle endpoints (change/reset/disable) and matching audit
  actions.
- Collapsing the download `?path=` existence oracle.

## Consequences

- Public endpoints answer 429 to abusive clients instead of burning argon2id.
- Logs no longer leak share credentials.
- Browsers get defense-in-depth headers; cross-site state-changing requests
  are rejected out-of-hand.
- Huge or crafted images cannot force large allocations.
- Uploads cannot exhaust the destination volume silently, and aborted
  uploads leave no residue.

## References

- docs/designs/016-security-hardening.md
- docs/roadmap.md Phase 16