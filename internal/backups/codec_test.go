package backups

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// roundTrip writes plaintext through a sink into a bytes.Buffer-backed file,
// then reads it back through openPayload, asserting integrity and content.
func roundTrip(t *testing.T, payload []byte, compress, encrypted bool) {
	t.Helper()
	testKey := []byte("0123456789abcdef0123456789abcdef")

	sink, err := newPayloadSink(compress, encrypted, testKey)
	if err != nil {
		t.Fatal(err)
	}
	defer sink.abort()

	dstFile := filepath.Join(t.TempDir(), "out")
	dst, err := os.Create(dstFile)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sink.Write(payload); err != nil {
		t.Fatal(err)
	}
	h, err := sink.Materialize(dst)
	if err != nil {
		t.Fatal(err)
	}
	if err := dst.Close(); err != nil {
		t.Fatal(err)
	}

	var key []byte
	if encrypted {
		key = testKey
	}
	got, err := os.ReadFile(dstFile)
	if err != nil {
		t.Fatal(err)
	}
	// Repair: Materialize wrote to dst; open the same file for reading.
	_ = got

	src, err := os.Open(dstFile)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = src.Close() }()

	pr, err := openPayload(src, key)
	if err != nil {
		t.Fatalf("openPayload: %v", err)
	}
	if h.Encrypted != pr.Header().Encrypted || h.Compressed != pr.Header().Compressed {
		t.Fatalf("header round-trip mismatch: wrote %+v read %+v", h, pr.Header())
	}
	body, err := io.ReadAll(pr)
	if err != nil {
		t.Fatal(err)
	}
	if err := pr.Err(); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(body, payload) {
		t.Fatalf("payload mismatch: got %q want %q", body, payload)
	}
}

func TestPayloadRoundTrip(t *testing.T) {
	payload := []byte("hello cairn — backup me, please")
	cases := []struct {
		name      string
		compress  bool
		encrypted bool
	}{
		{"raw", false, false},
		{"compressed", true, false},
		{"encrypted", false, true},
		{"compressed+encrypted", true, true},
		{"empty", false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var p []byte
			if !strings.HasPrefix(c.name, "empty") {
				p = payload
			}
			roundTrip(t, p, c.compress, c.encrypted)
		})
	}
}

func TestPayloadDetectsCorruption(t *testing.T) {
	testKey := []byte("0123456789abcdef0123456789abcdef")
	sink, err := newPayloadSink(true, true, testKey)
	if err != nil {
		t.Fatal(err)
	}
	defer sink.abort()
	fn := filepath.Join(t.TempDir(), "p")
	dst, err := os.Create(fn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sink.Write([]byte(strings.Repeat("a", 5000))); err != nil {
		t.Fatal(err)
	}
	if _, err := sink.Materialize(dst); err != nil {
		t.Fatal(err)
	}
	_ = dst.Close()

	b, err := os.ReadFile(fn)
	if err != nil {
		t.Fatal(err)
	}
	// Flip a bit near the tail, inside the payload (past header+gzip header).
	b[len(b)-6] ^= 0xff
	if err := os.WriteFile(fn, b, 0o600); err != nil {
		t.Fatal(err)
	}

	f, _ := os.Open(fn)
	defer func() { _ = f.Close() }()
	pr, err := openPayload(f, testKey)
	if err != nil {
		t.Fatalf("unexpected: corruption not caught at open is fine, but open returned err: %v", err)
	}
	if _, err := io.Copy(io.Discard, pr); err == nil {
		if err := pr.Err(); err == nil {
			t.Fatal("expected corruption to be detected (read error or checksum error)")
		}
	}
}

func TestPayloadRejectsTruncation(t *testing.T) {
	sink, err := newPayloadSink(false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer sink.abort()
	fn := filepath.Join(t.TempDir(), "p")
	dst, err := os.Create(fn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sink.Write([]byte(strings.Repeat("b", 2000))); err != nil {
		t.Fatal(err)
	}
	if _, err := sink.Materialize(dst); err != nil {
		t.Fatal(err)
	}
	_ = dst.Close()

	// Truncate the payload so the declared plaintext size can never be met.
	// Keep the 57-byte header intact so openPayload succeeds and the short
	// payload is what must be caught.
	if err := os.Truncate(fn, 67); err != nil {
		t.Fatal(err)
	}

	f, _ := os.Open(fn)
	defer func() { _ = f.Close() }()
	pr, err := openPayload(f, nil)
	if err != nil {
		t.Fatalf("openPayload: %v", err)
	}
	if _, err := io.Copy(io.Discard, pr); err == nil {
		if pr.Err() == nil {
			t.Fatal("expected truncation to be detected")
		}
	}
}

func TestKeyDerivationDeterministic(t *testing.T) {
	salt := []byte("fixed-salt-16b")
	a := deriveKey("s3cret", salt)
	b := deriveKey("s3cret", salt)
	c := deriveKey("other", salt)
	if string(a) != string(b) {
		t.Fatal("same passphrase+salt must derive same key")
	}
	if string(a) == string(c) {
		t.Fatal("different passphrase must derive different key")
	}
	if len(a) != 32 {
		t.Fatalf("key length = %d, want 32", len(a))
	}
}
