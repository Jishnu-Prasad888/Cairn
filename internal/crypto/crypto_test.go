package crypto

import (
	"bytes"
	"testing"
)

func TestDisabledKeysAreTransparent(t *testing.T) {
	k := NewKeys("")
	if k.Enabled() {
		t.Fatal("empty passphrase must disable encryption")
	}
	raw := []byte(`{"name":"photos"}`)
	if got := k.Seal(raw); !bytes.Equal(got, raw) {
		t.Errorf("disabled Seal changed data")
	}
	got, err := k.Open(raw)
	if err != nil {
		t.Fatalf("disabled Open: %v", err)
	}
	if !bytes.Equal(got, raw) {
		t.Errorf("disabled Open changed data")
	}
}

func TestSealOpenRoundTrip(t *testing.T) {
	k := NewKeys("correct horse battery staple")
	if !k.Enabled() {
		t.Fatal("passphrase must enable encryption")
	}
	raw := []byte(`{"id":"abc","schema_version":1,"name":"photos"}`)

	sealed := k.Seal(raw)
	if !IsSealed(sealed) {
		t.Fatal("sealed blob is not marked as sealed")
	}
	if bytes.Contains(sealed, []byte(`"photos"`)) {
		t.Error("sealed blob leaks plaintext")
	}

	got, err := k.Open(sealed)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if !bytes.Equal(got, raw) {
		t.Errorf("round trip mismatch: %s", got)
	}
}

func TestUniqueNoncesProduceDifferentBlobs(t *testing.T) {
	k := NewKeys("s3cret passphrase")
	raw := []byte("same plaintext")
	a := k.Seal(raw)
	b := k.Seal(raw)
	if bytes.Equal(a, b) {
		t.Error("identical blobs for repeated seals — nonce reuse risk")
	}
	ga, _ := k.Open(a)
	gb, _ := k.Open(b)
	if !bytes.Equal(ga, gb) {
		t.Error("seals with distinct nonces did not open to identical plaintext")
	}
}

func TestWrongPassphraseFails(t *testing.T) {
	k := NewKeys("right passphrase")
	wrong := NewKeys("wrong passphrase")
	sealed := k.Seal([]byte("secret payload"))
	if _, err := wrong.Open(sealed); err != ErrInvalidPassphrase {
		t.Errorf("wrong key Open = %v, want ErrInvalidPassphrase", err)
	}
}

func TestEnabledKeysReadLegacyPlaintext(t *testing.T) {
	k := NewKeys("a passphrase")
	plain := []byte(`{"id":"legacy"}`)
	got, err := k.Open(plain)
	if err != nil {
		t.Fatalf("Open plaintext: %v", err)
	}
	if !bytes.Equal(got, plain) {
		t.Errorf("plaintext passthrough changed data")
	}
}

func TestCorruptSealedRejected(t *testing.T) {
	k := NewKeys("a passphrase")
	sealed := k.Seal([]byte("payload"))
	sealed = sealed[:headerSize+4]
	if _, err := k.Open(sealed); err != ErrInvalidPassphrase {
		t.Errorf("truncated blob Open = %v, want ErrInvalidPassphrase", err)
	}

	// Correct magic but an unsupported version byte is structurally malformed.
	bad := make([]byte, headerSize+16)
	copy(bad, formatMagic[:])
	bad[len(formatMagic)] = 99
	if _, err := k.Open(bad); err != ErrCorrupt {
		t.Errorf("bad version blob Open = %v, want ErrCorrupt", err)
	}

	// Data that does not carry the magic is legacy plaintext, not an error.
	legacy := []byte(`{"id":"x"}`)
	if got, err := k.Open(legacy); err != nil || !bytes.Equal(got, legacy) {
		t.Errorf("legacy plaintext Open = %v, %v; want unchanged", got, err)
	}
}

func TestDeriveKeyStable(t *testing.T) {
	if !bytes.Equal(DeriveKey("p"), DeriveKey("p")) {
		t.Error("derivation is not deterministic")
	}
	if bytes.Equal(DeriveKey("p"), DeriveKey("q")) {
		t.Error("different passphrases derived the same key")
	}
	if len(DeriveKey("p")) != KeySize {
		t.Errorf("key size = %d, want %d", len(DeriveKey("p")), KeySize)
	}
}
