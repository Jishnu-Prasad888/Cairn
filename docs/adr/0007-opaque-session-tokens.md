# 0007 — Opaque server-side session tokens

- Status: accepted
- Date: 2026-09-22

## Context

Cairn needs browser-based sessions for its embedded web UI and cookie/cookie-jar
support for future native clients ([mobile-development.md](../mobile-development.md)).
The alternatives are opaque tokens with server-side state, self-contained tokens
(e.g. JWT), or a third-party identity provider.

Requirements: work without a bearer-header round trip complexity, revoke
immediately on logout, survive deployments that forget a signing secret, avoid
storing usable credentials in the database, and stay reviewable in a small
self-hosted product.

## Decision

Sessions are **opaque random tokens with server-side state**:

- A token is 32 bytes from `crypto/rand`, base64url-encoded, delivered as the
  `cairn_session` cookie (`HttpOnly`, `SameSite=Lax`, `Secure` when TLS is
  observed or configured).
- Only the **SHA-256 digest** of the token is persisted in `sessions`; the
  plaintext token exists only in the client's cookie jar.
- Sessions expire after 30 days; expiry is enforced on access and stale rows are
  pruned at startup. Logout deletes the row server-side.

## Consequences

- Revocation is immediate and cheap: delete a row (or all rows for a user).
- A database leak exposes digests, not usable tokens.
- No signing keys or external identity providers to manage or rotate.
- Stateless verification (JWT-style) is impossible; each request performs an
  indexed `sessions` lookup. This cost is negligible at Cairn's scale.
- Bearer tokens for server-to-server clients are deferred; the digest-based
  model supports them later without schema change.

The resource-based authorization model introduces scoped permissions but does
not change how a principal is established
([0005-resource-based-authorization.md](0005-resource-based-authorization.md)).