# Authentication

Not yet implemented (Phase 1). This document defines the requirements the
implementation will satisfy.

## Scope

- User accounts with secure password hashing (argon2id; never a homegrown hash).
- Sessions (HTTP-only cookies) with login, logout, current-user, and revocation.
- Initial `Admin`/`User` roles on top of the resource-based permission model
  ([permissions.md](permissions.md)); roles never replace that model.
- Audit logging of authentication events.

## Consent

Authentication and authorization remain separate concepts and separate packages.
Sessions identify the principal; the permission subsystem decides what the
principal may do.

## API shape (preview)

```text
POST     /api/v1/auth/login
POST     /api/v1/auth/logout
GET      /api/v1/auth/me
POST     /api/v1/users
POST     /api/v1/users/{id}/sessions/revoke
```

The OpenAPI security schemes will be updated when this lands (currently
intentionally empty).

## Privacy

Credentials, session tokens, and share tokens are never logged. Passwords never
leave the server except as hashes.