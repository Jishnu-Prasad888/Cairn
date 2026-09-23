# Encryption at Rest — Phase 13

Phase 13 adds optional, passphrase-driven encryption at rest for Cairn's own
on-disk metadata. It was implemented only after explicit consensus (the roadmap
marks this phase as "do not implement without consensus").

## Scope

Encryption covers the data Cairn itself writes into each library:

- `.cairn/library.json` — the library identity file.
- `.cairn/thumbs/*.jpg` — generated thumbnails.

User media **originals are never modified** (ADR-0004: libraries are catalogued
in place; the original file is never touched). Protecting the user's own photos
is the job of disk-level or filesystem-level encryption; protecting the *derived
Cairn state* that leaks previews and identity is what this phase does.

## Threat model

A `.cairn` directory left on a lost or reused disk currently exposes:

- the library's identity (id, name, creation time) in plaintext JSON;
- full-resolution previews (400 px thumbnails) of every indexed photo.

With Phase 13's envelope in place, that metadata yields nothing without the
passphrase. A photo thief who only has the disk cannot recover identity or
thumbnails; the originals themselves are outside this phase's scope (they are
the user's own unencrypted files, protected by the user's disk encryption).

## Design

### Key derivation and cipher

- A single server-wide passphrase comes from `CAIRN_ENCRYPTION_PASSPHRASE`.
- The 32-byte AES-256 key is derived with argon2id using a **fixed protocol
  salt** (`"cairn-at-rest-v1"`) and the same parameters as the backup codec
  (time=1, memory=64 MiB, threads=4). The passphrase is the only secret and is
  never stored; the fixed salt keeps derivation reproducible across restarts so
  files written before a restart remain readable afterwards.
- Each sealed artifact uses AES-256-GCM (authenticated encryption) with a fresh
  12-byte random nonce, so identical plaintexts produce different blobs and
  tampering is detected.
- The derived key is cached in memory for the process lifetime (no argon2id
  cost per request).

### Sealed blob format

```
[8] magic "CAIRNATR" | [1] version = 1 | [12] nonce | AES-256-GCM ciphertext+tag
```

Each blob is self-describing and independently movable.

### Enabled / disabled behavior

| Configuration       | Write                                               | Read                                         |
|---------------------|-----------------------------------------------------|----------------------------------------------|
| passphrase set      | seal (ciphertext on disk)                           | decrypt; legacy plaintext artifacts still read |
| no passphrase       | plaintext (unchanged behavior)                      | plaintext as-is                              |
| wrong passphrase    | —                                                   | `ErrInvalidPassphrase` (load/read fails loudly) |

Legacy artifacts (written before encryption was enabled, or on another install)
are readable in place with no migration: a blob that does not carry the seal
magic is treated as plaintext. Enabling encryption seals new writes; it does
not rewrite existing plaintext files. Disabling encryption leaves sealed files
unreadable until the passphrase is re-enabled.

## Components

- `internal/crypto` — the shared kernel: `DeriveKey`, `Keys` (`Seal`/`Open`/
  `Enabled`), `IsSealed`. A nil or empty-passphrase `Keys` is transparent, so
  callers never branch on configuration.
- `internal/library` — `Manager` holds the `*crypto.Keys`; identity creation,
  adoption, probing, and reconnect seal/decrypt `library.json`.
- `internal/metadata` — `GenerateThumbnail` seals on write; `ReadThumb` decrypts
  on read. `Processor` carries the keys for bulk background generation.
- `internal/httpapi` — the thumbnail route serves decrypted JPEG bytes through
  the at-rest key; encryption state is injected via `Dependencies.Keys`.
- `cmd/cairn` — derives `Keys` from config at boot and wires the library manager
  and HTTP server.

## Design decisions

- **Cairn-owned data only**: originals stay untouched (ADR-0004). Encrypting
  user files in place would change the library contract and is out of scope.
- **Passphrase, not key file**: consistent with backup passphrases; nothing is
  stored on disk, so a lost disk leaks no key material.
- **Fixed protocol salt**: required because nothing is stored on disk and
  derived keys must survive restarts. The salt is public protocol metadata; the
  argon2id cost is the brute-force barrier. Uses a strong passphrase.
- **AEAD (GCM) over backup-style CTR+SHA-256**: GCM is authenticated, so
  tampering or a wrong key is detected instead of producing garbage. The backup
  codec is unchanged in this phase (backup hardening is a follow-up).
- **SQLite files are not encrypted**: `modernc.org/sqlite` is pure-Go and has
  no encrypted-file backend (no SQLCipher/`PRAGMA key`). Encrypting the DB file
  at rest would require a custom ciphertext layer with WAL implications, which
  is high-risk and out of scope. SQLite metadata is instead protected via
  encrypted backups (Phase 10) when that protection is desired.

## Migration and operations

- No schema or format migration is needed. Existing libraries keep working with
  or without the passphrase.
- Set `CAIRN_ENCRYPTION_PASSPHRASE` on the server. Newly created/adopted
  identities and newly generated thumbnails are sealed.
- Changing the passphrase re-encrypts nothing automatically; sealed files are
  bound to the phrase they were written under.
- Enabling encryption after thumbnails exist leaves legacy plaintext
  thumbnails in place (still served); a re-scan regenerates and seals them.

## Follow-ups (out of scope)

- Harden the backup codec: migrate from CTR+SHA-256 to the shared AEAD kernel.
- Optional rewrite pass to seal legacy artifacts on demand.
- Full SQLite-at-rest encryption (requires a non-pure-Go backend or a custom
  ciphertext layer).