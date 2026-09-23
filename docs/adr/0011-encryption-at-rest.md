# ADR-0011: Optional passphrase-driven encryption at rest

Date: 2026-09-23

Status: implemented

## Context

Cairn keeps per-library metadata (`<root>/.cairn/library.json`) and generated
thumbnails (`.cairn/thumbs/*.jpg`) in the clear on the library disk. A lost or
reused disk exposes library identity and image previews. The roadmap's Phase 13
asked for "encryption at rest for metadata and media, with optional keys" and
required consensus before implementation (it is privacy-sensitive territory).

## Decision

Encrypt only the metadata Cairn itself owns, using a passphrase-derived
AES-256-GCM envelope:

- One server-wide optional passphrase, `CAIRN_ENCRYPTION_PASSPHRASE`.
- Key = argon2id(passphrase, fixed protocol salt), cached per process.
- `.cairn/library.json` and generated thumbnails are sealed on write and
  decrypted on read via a shared `internal/crypto` kernel.
- User media originals are never modified (ADR-0004 stands).

## Rationale

- **Cairn-owned data only**: originals are the user's own files; protecting them
  is disk-encryption territory. Rewriting them in place would violate the
  in-place library contract and surprise users.
- **Passphrase over key file**: parallel to the backup passphrase; nothing is
  stored on disk, so a stolen disk has no key material.
- **Fixed salt**: with nothing stored, derivation must be reproducible across
  restarts. The salt is public protocol metadata; argon2id cost (64 MiB, 4
  threads) is the brute-force barrier.
- **AEAD over the backup codec's CTR+SHA-256**: GCM authenticates; wrong keys
  and tampering fail closed instead of yielding garbage plaintext.
- **SQLite at-rest encryption rejected for now**: `modernc.org/sqlite` (pure
  Go) has no encrypted-file backend; a custom ciphertext-with-WAL layer is
  high-risk and deferred. Protected via encrypted backups instead.

## Consequences

- With no passphrase, behavior is unchanged and fully backward compatible;
  legacy plaintext artifacts remain readable after enabling.
- Enabling encryption seals new writes only, not existing plaintext files.
- A wrong or missing passphrase over a sealed identity file fails library
  adoption/reconnect loudly instead of corrupting state.
- Operations and migration are documented in `docs/encryption.md`; backups
  codec hardening and legacy rewrite passes are follow-ups.