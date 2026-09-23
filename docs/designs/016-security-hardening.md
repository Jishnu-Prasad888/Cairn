# 016 — Security Hardening

Status: implemented (see docs/roadmap.md Phase 16)
Related: ADR-0014, docs/roadmap.md (Phase 16)

## Problem

Phase 16 is a defensive review of Cairn's server surface. The goal is not new
features: it is to close the highest-value gaps an attacker (guest account,
brute-forcer, or network-local user) could exploit, without changing the
product's local-first model.

## Threat model

- The server may be reachable beyond loopback (proxy, Tailscale, LAN).
- Accounts are shared with family/guests; a guest may hold scoped capabilities.
- Media files on disk are attacker-influenced (imported photos, uploads).
- Destroying derived data is acceptable; originals are never modified.

## Review surface

The 13 areas from `todos/prompt.md`:

authentication, authorization, traversal, uploads, MIME handling, sessions,
shares, XSS, CSRF, SQL injection, rate limits, secrets, resource isolation,
logging.

## Findings (verified against source)

### Fixed in this phase

1. **No brute-force/DoS protection on auth surfaces** (high). `POST
   /auth/login`, `/auth/bootstrap`, and `/shares/{token}/authenticate` are
   public, unthrottled, and each login runs argon2id (≈64 MiB). An attacker
   can guess credentials or exhaust CPU/RAM. `CodeRateLimited` existed but no
   handler ever returned 429.
   → `internal/httpapi/ratelimit.go`: per-IP token bucket (burst-tolerant)
   plus a per-username failed-attempt lockout, applied to all three public
   endpoints; 429 + `RATE_LIMITED` after repeated failure. (R1)

2. **Share tokens are logged** (high). Public share routes place the bearer
   token in the URL path and the access-log middleware logs the full path, and
   `docs/authentication.md` claimed tokens were "never logged". A log reader
   could open any share.
   → Access log (and panic recovery) redact the `/shares/{token}/` segment;
   a regression test asserts no token reaches log output; the doc claim now
   holds. (R2)

3. **No security headers / no CSRF defense beyond `SameSite=Lax`** (medium).
   No CSP, `nosniff`, `Referrer-Policy`, or frame protections; no Origin
   validation on state-changing methods, and login/bootstrap are CSRF-able
   (session fixation).
   → Middleware sets baseline headers (`X-Content-Type-Options`,
   `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a `'self'` CSP)
   and rejects mismatched `Origin` on non-GET methods. SameSite Lax remains
   the primary CSRF defense; Origin checks are defense-in-depth. (C1, F1/F2)

4. **Image decode bombs** (high). Four `image.Decode` sites decode
   attacker-controlled files with no dimension/pixel cap: on-demand
   thumbnails, face crops, and both ML passes. A tiny crafted JPEG/PNG can
   force multi-GB allocations.
   → New `internal/safeimage.Decode`: `image.DecodeConfig` pre-check, reject
   `width*height > 50 MP` or a single dimension `> 30 000` px, then decode.
   Applied to `metadata/thumbnail.go`, `httpapi/faces.go`,
   `ml/ahash.go`, and `ml/faces.go`. (R3)

5. **Unbounded uploads** (medium-high). `ParseMultipartForm(32 MiB)` only
   bounds in-memory buffering; the remainder spools to disk with no total cap.
   Aborted uploads also strand `.cairn-upload-*` temp files.
   → Configurable `CAIRN_MAX_UPLOAD_BYTES` (default 2 GiB): request capped via
   `http.MaxBytesReader` (→ 413) and the store stream is additionally capped
   with `io.LimitReader` inside `WriteUpload`; temp files are removed
   unconditionally (`defer os.Remove`). (R4)

### Accepted / deferred (documented)

6. **Per-file filtering in aggregate listings** (medium). Recursive folder
   listing, search, trash, and favorites return metadata for files under a
   denied subtree. The public share handler already filters per file; the
   authenticated handlers do not. Deferred to keep this phase land-boundary
   small; tracked as follow-up (ADR-0014) because it changes aggregation
   semantics and needs a careful test matrix.
7. **Favorites are library-global** (medium). No `user_id`; any reader sees
   every favorite path. Requires a schema migration + backfill; deferred.
8. **Download `?path=` oracle** (low). A zero-grant account can distinguish
   existing vs missing rel_paths by 404/403. Mitigation: library IDs already
   require read to surface in practice; deferred with the authz filtering
   work.
9. **Symlink containment** (medium). Lexical-only path validation; a symlink
   inside a library pointing outside is followed. Skipping `ModeSymlink` in
   the scanner plus real-path resolution is deferred (needs care with
   "external drive" mounts); documented in ADR-0014.
10. **Login timing (user enumeration)** (medium). Unknown usernames skip
    argon2id while known ones pay its cost. Implemented a "dummy verify" so
    both branches take comparable time; the remaining difference is
    deliberate and acceptable.
11. **`LIKE` wildcard escaping** (medium). Folder filters interpolate
    `folder + "/%"`; a folder literally named `a_b`/`100%` could match
    siblings. Escaping `%`, `_`, and `\` added in the three folder-filter
    builders. (Follow-up: escaping tests added this phase.)
12. **Session binding, rotation, `__Host-` cookie, `Secure` via
    `X-Forwarded-Proto`** (low). Deferred; see ADR-0014.
13. **Password lifecycle endpoints** (medium): no change-password/reset/
    disable API, and `users.updated/disabled/enabled` audit constants are
    unreachable. Deferred to a follow-up (auth evolution), not a hot-fix.

## Out of scope (by design)

- CORS (intentionally none; same-origin SPA only).
- Rewriting authn/authz; the existing model is strong (central `requireCap`
  gate, most-specific-wins eval, hashed opaque tokens at rest, argon2id,
  audit discipline).
- Anything touching originals at rest.

## Test plan

- `internal/safeimage`: crafted 1×1 PNG patched to huge IHDR dimensions —
  `Decode` rejects with `ErrTooLarge` before allocation; legit photos decode.
- `internal/httpapi` `ratelimit_test.go`: N rapid bad logins → 429; lockout
  window; success resets the counter; burst under the rate limit still passes.
- `middleware_test.go`: cross-origin non-GET → 403, same-origin passes, GET
  with mismatched Origin passes (no CSRF on reads); every response carries
  the security headers; a `/shares/{token}/files` request's captured log has
  the token redacted.
- Upload: body over the cap → 413 and no `file` row; interrupted upload
  leaves no `.cairn-upload-*` temp in the library.
- ML/metadata: existing decode pipelines still pass with the guarded decoder.
- Escape: a folder literally named `a_b` returns only its own subtree.