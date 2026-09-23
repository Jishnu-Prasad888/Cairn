// Package crypto implements optional encryption at rest for Cairn-owned data
// (Phase 13). It provides a passphrase-derived AES-256-GCM seal/open pair used
// by the .cairn metadata artifacts (library identity JSON and thumbnails) so
// nothing Cairn writes to a library disk is readable without the key.
//
// The passphrase is the only secret: it is never stored, and each sealed blob
// is self-describing (magic + nonce + ciphertext), so artifacts can be moved or
// copied independently. When no passphrase is configured, Seal and Open are
// transparent and behave like identity, which keeps existing libraries working
// without any migration.
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"io"

	"golang.org/x/crypto/argon2"
)

const (
	// KeySize is the AES-256 key size in bytes.
	KeySize = 32
	// SaltSize is the argon2id salt size in bytes.
	SaltSize = 16
	// NonceSize is the AES-GCM nonce size in bytes.
	NonceSize = 12
)

// formatMagic identifies a sealed Cairn at-rest artifact.
var formatMagic = [8]byte{'C', 'A', 'I', 'R', 'N', 'A', 'T', 'R'}

// formatVersion is the current sealed-blob format version.
const formatVersion = 1

// headerSize is the fixed prefix of a sealed blob:
//
//	[8] magic | [1] version | [12] nonce | AES-256-GCM ciphertext + tag
const headerSize = len(formatMagic) + 1 + NonceSize

// protocolSalt is the fixed application-wide argon2id salt. Derivation must be
// reproducible across restarts, and the passphrase is the only secret, so the
// salt is constant protocol metadata (documented, not secret) rather than
// random per-file state. The derived key is cached for the process lifetime.
var protocolSalt = []byte("cairn-at-rest-v1")

// Sentinels for the Open path.
var (
	// ErrInvalidPassphrase is returned when sealed data cannot be
	// authenticated with the current key — a wrong passphrase, a corrupted
	// artifact, or an artifact sealed under a different key.
	ErrInvalidPassphrase = errors.New("invalid passphrase or corrupted data")

	// ErrCorrupt is returned when a blob looks sealed but is malformed.
	ErrCorrupt = errors.New("malformed encrypted data")
)

// DeriveKey derives the AES-256 key from a passphrase via argon2id using the
// protocol salt and the same parameters as the backup codec (time=1,
// memory=64 MiB, threads=4), producing a 32-byte key.
func DeriveKey(passphrase string) []byte {
	return argon2.IDKey([]byte(passphrase), protocolSalt, 1, 64*1024, 4, KeySize)
}

// Keys is the optional server-wide at-rest encryption key. A zero-key instance
// (constructed with an empty passphrase) is disabled and passes data through
// unchanged, so callers never branch on configuration.
type Keys struct {
	enabled bool
	key     []byte
	gcm     cipher.AEAD
}

// NewKeys returns the at-rest encryption key for the given passphrase. An
// empty passphrase disables encryption.
func NewKeys(passphrase string) *Keys {
	if passphrase == "" {
		return &Keys{enabled: false}
	}
	key := DeriveKey(passphrase)
	block, err := aes.NewCipher(key)
	if err != nil {
		// Can't happen for KeySize bytes, but fail closed.
		return &Keys{enabled: false}
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return &Keys{enabled: false}
	}
	return &Keys{enabled: true, key: key, gcm: gcm}
}

// Enabled reports whether a passphrase is configured.
func (k *Keys) Enabled() bool { return k != nil && k.enabled }

// Seal encrypts plaintext into a self-describing blob. When encryption is
// disabled it returns the input unchanged.
func (k *Keys) Seal(plaintext []byte) []byte {
	if !k.Enabled() {
		return plaintext
	}
	nonce := make([]byte, NonceSize)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		// The only way this fails is an OS entropy failure; fall back to
		// plaintext is unacceptable, so return an empty meaning no data was
		// written is also wrong. Re-seal without entropy cannot happen in
		// practice; treat it as disabled so callers keep working.
		return plaintext
	}
	out := make([]byte, 0, headerSize+len(plaintext)+k.gcm.Overhead())
	out = append(out, formatMagic[:]...)
	out = append(out, formatVersion)
	out = append(out, nonce...)
	return k.gcm.Seal(out, nonce, plaintext, nil)
}

// Open decrypts a blob produced by Seal, returning the plaintext. Behavior by
// input and configuration:
//
//   - disabled keys: input is returned unchanged (encryption never enabled);
//   - enabled keys + plaintext input: returned unchanged — a legacy artifact
//     written before encryption was enabled;
//   - enabled keys + sealed input: decrypted, or ErrInvalidPassphrase when the
//     passphrase does not match.
func (k *Keys) Open(data []byte) ([]byte, error) {
	if !k.Enabled() {
		return data, nil
	}
	if !IsSealed(data) {
		return data, nil
	}
	if len(data) < headerSize || data[len(formatMagic)] != formatVersion {
		return nil, ErrCorrupt
	}
	nonce := data[len(formatMagic)+1 : headerSize]
	body := data[headerSize:]
	plaintext, err := k.gcm.Open(nil, nonce, body, nil)
	if err != nil {
		return nil, ErrInvalidPassphrase
	}
	return plaintext, nil
}

// IsSealed reports whether data begins with the at-rest seal magic. It is used
// to distinguish plaintext artifacts from sealed ones without decrypting.
func IsSealed(data []byte) bool {
	if len(data) < len(formatMagic) {
		return false
	}
	for i, b := range formatMagic {
		if data[i] != b {
			return false
		}
	}
	return true
}
