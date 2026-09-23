package crypto

import (
	"bytes"
	"testing"
)

func TestDisabledKeysAreTransparent(t *testing.T) {
	keys := NewKeys("")
	if keys.Enabled() {
		t.Fatal("empty passphrase must yield a disabled Keys")
	}
	plain := []byte("hello world")
	if got := keys.Seal(plain); !bytes.Equal(got, plain) {
		t.Error("disabled Seal must return input unchanged")
	}
	got, err := keys.Open(plain)
	if err != nil {
		t.Fatalf("disabled Open: %v", err)
	}
	if !bytes.Equal(got, plain) {
		t.Error("disabled Open must return input unchanged")
	}
	if IsSealed(plain) {
		t.Error("disabled Keys must not mark plaintext as sealed")
	}
}

func TestEnabledKeysRoundTripAndSealIdentity(t *testing.T) {
	keys := NewKeys("test passphrase")
	if !keys.Enabled() {
		t.Fatal("non-empty passphrase must yield an enabled Keys")
	}
	plain := []byte("secret payload")
	sealed := keys.Seal(plain)
	if bytes.Equal(sealed, plain) {
		t.Error("enabled Seal must not equal the input")
	}
	if !IsSealed(sealed) {
		t.Error("enabled Seal output must be detectable as sealed")
	}
	opened, err := keys.Open(sealed)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if !bytes.Equal(opened, plain) {
		t.Error("Open did not recover exact plaintext")
	}
}

func TestEnabledKeysRejectWrongPassphrase(t *testing.T) {
	sealer := NewKeys("correct passphrase")
	wrong := NewKeys("different passphrase")
	sealed := sealer.Seal([]byte("top secret"))
	if _, err := wrong.Open(sealed); err != ErrInvalidPassphrase {
		t.Fatalf("wrong passphrase: got %v, want ErrInvalidPassphrase", err)
	}
}

func TestEnabledKeysRejectCorruptBlob(t *testing.T) {
	keys := NewKeys("test")
	sealed := keys.Seal([]byte("payload"))

	// Truncated sealed blob.
	if _, err := keys.Open(sealed[:9]); err != ErrCorrupt {
		t.Fatalf("truncated: got %v, want ErrCorrupt", err)
	}
	// Bytes that merely carry the magic header but no ciphertext.
	bogus := append([]byte(magic), 'x')
	if _, err := keys.Open(bogus); err != ErrCorrupt {
		t.Fatalf("bogus header: got %v, want ErrCorrupt", err)
	}
	// Tampered ciphertext must fail authentication.
	tampered := append([]byte(nil), sealed...)
	tampered[len(tampered)-1] ^= 0x01
	if _, err := keys.Open(tampered); err == nil {
		t.Fatal("tampered blob opened without error")
	}
}

func TestEnabledKeysReadLegacyPlaintext(t *testing.T) {
	keys := NewKeys("test")
	legacy := []byte("plaintext written before encryption")
	got, err := keys.Open(legacy)
	if err != nil {
		t.Fatalf("Open legacy plaintext: %v", err)
	}
	if !bytes.Equal(got, legacy) {
		t.Error("legacy plaintext must pass through unchanged")
	}
}

func TestDeriveKeyStableAndDistinct(t *testing.T) {
	seed := []byte("payload")
	a := NewKeys("same passphrase").Seal(seed)
	b := NewKeys("same passphrase").Seal(seed)
	if bytes.Equal(a, b) {
		t.Error("two seals must use different nonces (randomization)")
	}
	keyOpenA, _ := NewKeys("same passphrase").Open(a)
	if !bytes.Equal(keyOpenA, seed) {
		t.Error("same passphrase must reproduce the key across instantiations")
	}
}
