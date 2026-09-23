---
title: Backup codec hardening to the shared AEAD kernel
status: accepted
date: 2026
related:
  - 0010-backup-format
  - 0011-encryption-at-rest
supersedes: []
---

# ADR-0012 — Backup codec hardening to the shared AEAD kernel

## Status

Accepted (Phase 14).

## Context

Phase 13 (ADR-0011) delivered a shared at-rest encryption kernel
(`internal/crypto`, docs/encryption.md): argon2id-derived AES-256-GCM AEAD
with a self-describing sealed blob format, used for `.cairn` identity and
thumbnails. It was explicitly scoped to *Cairn-owned metadata artifacts*, and
documented a first-class follow-up:

> Harden the backup codec: migrate from CTR + SHA-256 to the shared AEAD
> kernel so tampering/truncation of a backup payload is detected and the
> passphrase is enforced by a real authenticated cipher.

Today, encrypted backups (Phase 10, ADR-0010) use an older, separate codec:

- **Confidentiality:** passphrase → per-backup random salt → argon2id
  (`deriveKey`) → **AES-256-CTR** streaming.
- **Integrity:** **unkeyed SHA-256** of the plaintext, recorded in the header.

CTR is only a stream cipher — it converts bytes with no authentication. Its
SHA-256 partner is *unkeyed*, so it detects accidental corruption but cannot
distinguish a forgery from legitimate data: a re-forged plaintext simply
re-hashes. The pair also leaves the codec unable to tell a wrong passphrase
apart from a corrupt blob — CTR decryption with a wrong key yields garbage
that then fails the SHA-256 check, producing a misleading "corrupt" error
instead of "wrong passphrase", and (worse) before the hash check is computed
that garbage may be partially emitted.

ADR-0010's Phase-10 code also records no key-versioning: the header's flags
byte is the only signal, and AEAD introduction must not break legacy CTR
payloads already written to disk.

## Decision

Migrate the encrypted-backup payload codec from **CTR + unkeyed
SHA-256** to Cairn's **one shared AEAD kernel** (`internal/crypto`), with:

1. **One derivation, one blob format, one primitive.** Encrypted backup
   payloads become the same self-describing sealed blob Phase 13 introduced
   — argon2id-keyed AES-256-GCM with magic + version + nonce + tag — sealed
   and opened via `crypto.Keys.Seal`/`Open`. Wrong passphrase and tampering
   are now *authenticated* errors (`ErrInvalidPassphrase`, `ErrCorrupt`) the
   moment `Open` runs, long before any byte is served.
2. **Shared kernel, not a parallel codec.** The Phase-13 kernel is reused
   verbatim (`crypto.NewKeysFromKey` feeds the backups codec's already-
   derived backup key, since backups carry their own random salt and the
   kernel consumes a raw AEAD key). This keeps the "one ciphertext
   primitive in the repo" invariant ADR-0011 established, and deletes the
   backup-specific argon2id/CTR/SHA-256 derivation as a *writer*.
3. **Backward compatible, in both directions:**
   - New AEAD payloads are written by the codec going forward.
   - **Legacy CTR payloads already on disk remain restorable and verifiable**
     byte-for-byte via the retained legacy reader — no re-backup, no
     migration step, no expiry.
   - The unencrypted path is unchanged (transparent passthrough before and
     after), so libraries that never configured a passphrase are untouched.
4. **The biometric/json path is untouched.** Only `internal/backups` codec
   internals move. The backup REST surface (`/api/v1/backups/*`), the
   manifest schema, retention, and the passphrase env var are unchanged.

### How the migration is made safe

The on-disk *header* is byte-identical to Phase 10 (same magic, flags, sizes,
sizes, hash fields). Only the **body bytes after the header** change:

- Body starts with the Phase-13 sealed-blob magic (`CAIRNATR` + version):
  **AEAD.** The codec opens via the kernel; a mangled or wrong-key blob fails
  with the authenticated `ErrInvalidPassphrase`/`ErrCorrupt`.
- Body does not start with the magic (legacy CTR ciphertext, or plaintext):
  the **legacy reader runs unchanged** — salt → deriveKey → CTR → SHA-256.

Dispatch is by inspecting the first body bytes for the sealed blob's magic,
which is unambiguous because the AEAD magic `CAIRNATR` can never coincide with
a legacy ciphertext stream's first 8 bytes in practice (and is validated by a
round-trip test on both formats).

### Integrity semantics now provided

| Property | CTR + SHA-256 (legacy) | AEAD kernel (new) |
|---|---|---|
| Confidentiality | AES-256-CTR | AES-256-GCM |
| Integrity (corruption) | sha256 header | GCM tag (auth) |
| Tamper detection | none (unkeyed hash) | GCM tag (authenticated) |
| Wrong-passphrase detection | none (fails as corrupt) | `ErrInvalidPassphrase` |
| Serve-before-verify | possible | impossible (auth before emit) |

## Consequences

Positive:

- Encrypted backups are now **authenticated**: truncation, tampering, or a
  wrong passphrase is detected and refused up front, never silently mangled
  or partially restored.
- One AEAD kernel (+ argon2id params) everywhere: identity, thumbnails, and
  backups. The Phase-10 argon2id/CTR derivation disappears as a writer; the
  shared kernel is the only ciphertext primitive in the tree.
- Clear, typed errors: `ErrInvalidPassphrase` (wrong passphrase) vs
  `ErrCorrupt` (truncated/tampered) — the codec no longer conflates them.
- Zero migration for operators: existing CTR backups restore/verify as before;
  new backups are sealed.

Negative / trade-offs:

- The codec grows a small legacy-reader branch that must outlive the codec
  migration. Documented and pinned by the legacy read test; removal is
  deferred until the safety window closes (see below).
- The Phase-10 header's stored-byte accounting now records the *sealed* size
  for new payloads (larger than the legacy stored size); readers already
  tolerate this because `StoredSize` is a field read from the header, not
  derived. Verified by test.
- AEAD sealing is CPU-heavier than CTR of old backups; KDF params intentionally
  unchanged (same argon2id cost) so the marginal cost is only per-GCM.

## Follow-ups (out of scope, recorded)

- **Legacy-reader retirement:** once no production install can still hold a
  CTR-only backup, drop the legacy branch and encode an explicit codec-version
  so only AEAD payloads are accepted. Requires a length-of-service guarantee;
  deferred.
- **Backup restore authenticate-then-write ordering** is already achieved by
  Open; a follow-up may add in-transit MAC for streaming-restore chunks
  (non-goal now).
- **SQLite-at-rest DB encryption** remains deferred (ADR-0011).
