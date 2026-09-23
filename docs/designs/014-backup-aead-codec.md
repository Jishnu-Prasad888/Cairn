# Backup codec migration: CTR+SHA-256 → shared AEAD kernel

**Phase:** 14 · **Design doc** · **Base:** Phase 13 (main, be55e9d)
**Package:** `internal/backups` (codec) + `internal/crypto` (kernel, additive)
**ADR:** ADR-0012

## Context

Phase 14 is the Phase 13 follow-up that docs/encryption.md deferred as its
first hardening item ("Migrate the backup codec from CTR+SHA-256 to the shared
AEAD kernel"). Cairn now has exactly one AEAD kernel (`internal/crypto`, Phase
13: argon2id-derived AES-256-GCM with a self-describing sealed blob) used for
the `.cairn` identity and thumbnail artifacts, and it has a Phase 10 backup
codec that still sits on `internal/backups/codec.go`:

- ink derivation: `argon2.IDKey(passphrase, per-backupSalt, 1, 64MiB, 4, 32)`
- confidentiality: **AES-256-CTR** streaming cipher (XOR keystream)
- integrity: unkeyed **SHA-256** of the plaintext stored in the payload header

So Cairn currently has **two** at-rest crypto stacks and two on-disk blob
formats. CTR without authentication is exactly the weakness that Phase 13
documents as the reason the shared kernel is AEAD: a malicious actor who can
write to a backup store (or an undetected disk fault/truncation) can flip bits
in a CTR ciphertext and, because SHA-256 is unkeyed and CTR is stream-cipher
positional, the "verify" step either can't distinguish it or silently accepts a
re-forged byte stream whose plaintext hash was appended to match.

## Goal

Move the backup codec's payload confidentiality+integrity onto the shared Phase
13 AEAD kernel so that **every** encrypted byte path in Cairn uses one kernel,
one derived-key rule, one self-describing sealed blob, and one authenticated-
decryption path with a single wrong-passphrase contract. Concretely:

1. `internal/crypto` gains a harmless, additive entry point so callers can
   hand the kernel an **already-derived** 32-byte raw key (`NewKeys` still
   exists; the argon2id derivation site used by backups gets a thin variant
   that seals/opens with its own derived key via `NewKeysFromKey`).
2. The backup payload format is **extended, never broken**: the legacy CTR
   codec reads/writes stay byte-identical, and a **new `flagAEADSealed`
   flag bit** on the existing payload header marks payloads sealed by the
   shared kernel. Old backups written before Phase 14 still decrypt, verify,
   and restore correctly (backward compatible). New encrypted backups write
   AEAD-sealed payloads.
3. Tampering/truncation with the wrong key is detected loudly at open time
   (GCM authentication) instead of silently producing garbage through
   vie-a-mêlé de CTR+SHA-256's best-effort mismatch.
4. Passphrase-encrypted user installs: no behavior change, no migration
   step, no new config knob. The same `BackupPassphrase`/codec flow powers it;
   the format flag + Friday-blob carrying just an argon2id-derived key mean
   creation/restore/verify keep their existing signatures.

A corollary, unstated but important: the backup codec is the **only remaining
CTR/SHA-256 artifact** in the tree. After Phase 14 the `internal/crypto`
kernel is the single ciphertext primitive, and no future hardening phase has a
weaker unicrypto sibling to hunt.

## Non-goals

- Changing the argon2id KDF parameters or the derivation salt/salt-storage
  scheme. Phase 13 already fixed derivation time/memory; Phase 14 reuses it.
- Encrypting the SQLite databases directly (out of scope from Phase 13;
  still protected via encrypted backups).
- Rolling/rotating passphrases, key files, or a onboarding "set a passphrase
  now" UI. Phase 14 is a codec migration only.
- Changing the REST API, manager signatures, or the unencrypted path.
- Migrating *already-written* legacy CTR payloads at create time — old
  payloads keep their format (read-only) and new payloads are AEAD; no
  re-encryption of history is attempted.

## Design

### Shared kernel is the only ciphertext primitive

Extend `internal/crypto` with one additive constructor, keeping the Phase 13
kernel untouched otherwise. Because the kernel's `Keys` seals/opens with the
argon2id-derived key internally, we need a way to construct an **enabled
`Keys` from an externally-derived key** (the backup codec derives its key from
`deriveKey(passphrase, salt)`). The design:

```go
// NewKeysFromKey returns an enabled Keys that seals and opens with the given
// 32-byte AES-256 key, without running argon2id. It is for callers who have
// already derived a key (the backup codec, which carries its own salt in the
// header) and want the single shared AEAD blob format. nil/zero-length or
// non-32-byte key returns a disabled Keys (transparent passthrough), mirroring
// NewKeys("").
func NewKeysFromKey(key []byte) *Keys
```

`Keys` already supports enabled/disabled transparent behaviors (`NewKeys("")`
→ disabled), so `NewKeysFromKey` fits the existing contract exactly: an AEAD
key is not written to disk, and a nil/zero key is the existing disabled state.

The backup codec keeps its argon2id derivation site (same parameters/salt
length as today — no KDF change), then hands the 32-byte result to
`crypto.NewKeysFromKey` and uses `keys.Seal`/`keys.Open`/`keys.Enabled()` —
the exact same methods the metadata and library layers use. The magic and
blob format shared with identity/thumbnails (Phase 13) are reused verbatim;
a sealed backup payload is cryptographically the same kind of blob as a
sealed thumbnail.

### Format

Extend the existing backup payload header rather than inventing a second one.
`fileHeader.flags` currently has `flagCompressed` and `flagEncrypted` (CTR).
Add one more bit:

```go
const flagAEADSealed = 1 << 2 // payload is sealed with the shared AEAD kernel
```

- `flagEncrypted` alone: legacy CTR reads/writes (as today), kept for
  backward compatibility with pre-Phase-14 backups.
- `flagEncrypted | flagAEADSealed`: payload body bytes are the output of
  `keys.Seal(...)` (GCM), authenticated.
- (No change to flagCompressed semantics.)

On write: after `deriveKey`, call `crypto.NewKeysFromKey(key)` and feed the
plaintext through `keys.Seal(dst)` — the kernel appends nonce+tag and magic,
so the sealed byte stream is longer than plaintext by the GCM overhead. The
stored size reflects the sealed size suffix hm, naturally.

On read (restore/verify): the header tells us which of the two branches:
`flagAEADSealed` → build keys from `deriveKey` and stream through
`keys.Open` (rejecting tamper: `ErrInvalidPassphrase`/`ErrCorrupt`); else
legacy CTR branch unchanged dependency on the existing nonce+CTR reader.

Because the AEAD blob starts with the fixed Phase 13 magic and carries its own
version/nonce/tag, the reader can also reliably detect a **legacy CTR blob**
unambiguously even without the flag bit, via `crypto.IsSealed` on the first
bytes of the payload body. The flag bit is still written for the header's
self-documentation and to preserve sha/plaintext bookkeeping unchanged.

### verify

Backup `Verify` needs the same detection: if `flagAEADSealed`, open through
the kernel (authenticated — a truncated/tampered blob or wrong key fails GCM
immediately, surfaced as `ErrInvalidPassphrase` or `ErrCorrupt` rather than
undefined decompressed garbage); legacy path unchanged. `Verify`'s
signature/return shape is unchanged.

## Tamper-detection property (why AEAD > CTR+SHA-256)

CTR's SHA-256 authencticty is broken on purpose anywhere an attacker can
observe/forge the plaintext-hash relation, and truncation is common with
stream ciphers; GCM is the documented correct construction. Backups are the
ciphertext a user will copy around the most (off-site/pruned), so this matters
most there. This phase is the direct, pinned Phase 13 follow-up.

## Compatibility matrix

| Backup written by | Readable/verifiable by Phase 14? |
|---|---|
| unencrypted (any phase) | yes — passthrough unchanged |
| Phase 10–13 CTR encrypted | yes — legacy CTR branch retained |
| Phase 14 AEAD encrypted | yes — kernel branch |

No existing on-disk backup changes; no restore/verify semantics change for
encrypted installs; passphrase handling identical.

## Migration/ops notes for reviewers

- Empty `BackupPassphrase` → `deriveKey` not called, `flagEncrypted` unset →
  payload written plaintext-compressed as today (byte-identical to Phase 13).
- Explicitly choosing AEAD vs legacy on write defaults to **AEAD for new
  encrypted backups**; legacy CTR is exercised in tests via a pre-written
  fixture so encoding stays proven.
- KDF cost unchanged (argon2id, 64 MiB mem, time=1, threads=4) — no server
  resource spike, no new env knobs; the passphrase flow is exactly Phase 13's.

## Risks / mitigations

- **Blob-size bookkeeping**: sealed payload is larger than plaintext; the
  payload sink's `StoredSize`/plaintext-size accounting already tolerates a
  size delta for compression-bit; verify via tests that header sizes reflect
  sealed sizes for both branches.
- **Two active branches to maintain**: contained — the legacy CTR branch is
  read-only after this phase, retained strictly for old backups.
- **Wrong-key UX**: with AEAD, a wrong passphrase fails `Open` with the
  sentinel at first authenticated read (clean error, no partial garbage);
  legacy stays best-effort (SHA-256 mismatch) as today. Tests assert both.

## Acceptance

- `TestBackupAEADCodecRoundTrip` (manager-level): create encrypted AEAD
  backup, restore+verify, tamper a byte in the stored payload → verify refuses
  with authenticated-cipher error and restore refuses; on-disk payload is
  `crypto.IsSealed`.
- `TestBackupLegacyCTRStillReads` with a pre-seeded legacy-format fixture →
  restore/verify byte-identical (regression guard).
- `TestBackupAEADWrongPassphrase` → restore/verify fail with
  `ErrInvalidPassphrase`, not garbage.
- Existing full suite (including encrypted backups run) stays green; pipeline
  format/lint/vet/test + docker + frontend + lint all green.
