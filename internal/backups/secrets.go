package backups

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/Jishnu-Prasad888/Cairn/internal/crypto"
)

// secretBox seals remote-destination credentials before they are written to
// the server database. The key lives in its own file in the data directory,
// so the database — which every backup copies, possibly to the very server
// those credentials unlock — never holds them in the clear. A restored
// database without the key file just asks for the credentials again.
type secretBox struct {
	keyPath string
	keys    *crypto.Keys
}

const secretKeyFile = "backup-secrets.key"

func newSecretBox(dataDir string) *secretBox {
	if dataDir == "" {
		return &secretBox{}
	}
	return &secretBox{keyPath: filepath.Join(dataDir, secretKeyFile)}
}

// load reads the key, creating it on first use.
func (s *secretBox) load(create bool) (*crypto.Keys, error) {
	if s.keys != nil {
		return s.keys, nil
	}
	if s.keyPath == "" {
		return nil, errors.New("no data directory for the backup credential key")
	}
	key, err := os.ReadFile(s.keyPath)
	switch {
	case err == nil && len(key) == 32:
	case err == nil:
		return nil, fmt.Errorf("%s is corrupt (want 32 bytes, got %d)", s.keyPath, len(key))
	case errors.Is(err, os.ErrNotExist) && create:
		key = make([]byte, 32)
		if _, err := io.ReadFull(rand.Reader, key); err != nil {
			return nil, err
		}
		if err := os.MkdirAll(filepath.Dir(s.keyPath), 0o700); err != nil {
			return nil, err
		}
		if err := os.WriteFile(s.keyPath, key, 0o600); err != nil {
			return nil, err
		}
	default:
		return nil, err
	}
	s.keys = crypto.NewKeysFromKey(key)
	return s.keys, nil
}

func (s *secretBox) seal(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	k, err := s.load(true)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(k.Seal([]byte(plain))), nil
}

func (s *secretBox) open(sealed string) (string, error) {
	if sealed == "" {
		return "", nil
	}
	k, err := s.load(false)
	if err != nil {
		return "", fmt.Errorf("backup credentials cannot be unsealed (%w); enter them again", err)
	}
	raw, err := base64.StdEncoding.DecodeString(sealed)
	if err != nil {
		return "", err
	}
	plain, err := k.Open(raw)
	if err != nil {
		return "", fmt.Errorf("backup credentials cannot be unsealed (%w); enter them again", err)
	}
	return string(plain), nil
}
