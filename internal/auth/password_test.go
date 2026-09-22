package auth

import (
	"strings"
	"testing"
)

func TestHashAndVerifyPassword(t *testing.T) {
	hash, err := hashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("hashPassword: %v", err)
	}

	ok, err := verifyPassword("correct horse battery staple", hash)
	if err != nil {
		t.Fatalf("verifyPassword: %v", err)
	}
	if !ok {
		t.Fatal("expected password to verify")
	}

	ok, err = verifyPassword("wrong password", hash)
	if err != nil {
		t.Fatalf("verifyPassword (wrong): %v", err)
	}
	if ok {
		t.Fatal("wrong password must not verify")
	}
}

func TestHashesAreSalted(t *testing.T) {
	h1, err := hashPassword("same password")
	if err != nil {
		t.Fatal(err)
	}
	h2, err := hashPassword("same password")
	if err != nil {
		t.Fatal(err)
	}
	if h1 == h2 {
		t.Fatal("two hashes of the same password must differ (unique salt)")
	}
}

func TestVerifyPasswordRejectsMalformedHash(t *testing.T) {
	for _, bad := range []string{
		"",
		"$argon2i$v=19$m=65536,t=3,p=2$c2FsdA$aGFzaA",
		"$argon2id$v=19$m=65536,t=3,p=2$c2FsdA",
		"not-a-phc-hash",
	} {
		if _, err := verifyPassword("pw", bad); err == nil {
			t.Errorf("verifyPassword(%q): expected error, got nil", bad)
		}
	}
}

func TestVerifyPasswordRejectsCorruptedKey(t *testing.T) {
	hash, err := hashPassword("pw")
	if err != nil {
		t.Fatal(err)
	}
	// Flip the final base64 char, corrupting the stored key.
	corrupted := hash[:len(hash)-1] + "a"
	ok, err := verifyPassword("pw", corrupted)
	if err != nil {
		t.Fatalf("verifyPassword corrupt: %v", err)
	}
	if ok {
		t.Fatal("corrupted hash must not verify")
	}
}

func TestParsePhcParamsRoundtrip(t *testing.T) {
	hash, err := hashPassword("pw")
	if err != nil {
		t.Fatal(err)
	}
	salt, params, key, err := parsePhc(hash)
	if err != nil {
		t.Fatalf("parsePhc: %v", err)
	}
	if len(salt) != argonSaltLen {
		t.Errorf("salt length = %d, want %d", len(salt), argonSaltLen)
	}
	if len(key) != argonKeyLen {
		t.Errorf("key length = %d, want %d", len(key), argonKeyLen)
	}
	if params.memory != argonMemory || params.time != argonTime || params.threads != argonThreads {
		t.Errorf("params = %+v, want m=%d t=%d p=%d", params, argonMemory, argonTime, argonThreads)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$") {
		t.Errorf("hash does not start with argon2id v19 marker: %q", hash)
	}
}
