# Sharing

Not yet implemented (planned with the authorization phase). Requirements:

## Public share links

- Cryptographically random share tokens. Internal database IDs are never used as
  security credentials.
- Optional expiration.
- Optional password protection.
- Fine-grained permissions: view, download, edit where appropriate.
- Revocation; shared resources stop being accessible to the token immediately.
- Audit of share creation and revocation.

## Semantics

Shares reference resources (an album, a folder, a photo, a memory). Access flows
through the same authorization evaluation as everything else; a share grants
access only through the explicit share grant, never by bypassing permissions.