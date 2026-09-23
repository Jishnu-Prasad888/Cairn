// Package backups implements Phase 10: incremental, compressed, optionally
// encrypted backups of every registered library (media files and .cairn
// metadata) and of the server database, with retention, verification, and
// restore. See docs/backups.md and ADR-0008.
package backups

import (
	"bufio"
	"compress/gzip"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"time"

	"golang.org/x/crypto/argon2"
)

// formatMagic identifies a Cairn backup payload.
var formatMagic = [8]byte{'C', 'A', 'I', 'R', 'N', 'B', 'K', 0x01}

// headerSize is the fixed binary header preceding every stored payload,
// immediately followed by the 16-byte IV when the payload is encrypted:
//
//	[8] magic | [1] flags | [32] sha256 | [8] plaintext size | [8] stored size
const headerSize = 8 + 1 + 32 + 8 + 8

// nonceSize is the AES block-size IV carried after the header when encrypted.
const nonceSize = aes.BlockSize

const (
	flagCompressed = 1 << 0
	flagEncrypted  = 1 << 1
)

// fileHeader describes one stored payload.
type fileHeader struct {
	Compressed    bool
	Encrypted     bool
	SHA256Hex     string
	PlaintextSize uint64
	StoredSize    uint64
}

func (h fileHeader) encode() []byte {
	buf := make([]byte, 0, headerSize)
	buf = append(buf, formatMagic[:]...)
	var flags byte
	if h.Compressed {
		flags |= flagCompressed
	}
	if h.Encrypted {
		flags |= flagEncrypted
	}
	buf = append(buf, flags)
	sum, err := hex.DecodeString(h.SHA256Hex)
	if err != nil || len(sum) != sha256.Size {
		sum = make([]byte, sha256.Size)
	}
	buf = append(buf, sum...)
	buf = binary.BigEndian.AppendUint64(buf, h.PlaintextSize)
	buf = binary.BigEndian.AppendUint64(buf, h.StoredSize)
	return buf
}

// decodeHeader parses the leading header bytes and checks the magic.
func decodeHeader(b []byte) (fileHeader, error) {
	if len(b) < headerSize {
		return fileHeader{}, errors.New("backup payload header truncated")
	}
	if string(b[:8]) != string(formatMagic[:]) {
		return fileHeader{}, errors.New("not a Cairn backup payload (bad magic)")
	}
	var h fileHeader
	flags := b[8]
	h.Compressed = flags&flagCompressed != 0
	h.Encrypted = flags&flagEncrypted != 0
	h.SHA256Hex = hex.EncodeToString(b[9:41])
	h.PlaintextSize = binary.BigEndian.Uint64(b[41:49])
	h.StoredSize = binary.BigEndian.Uint64(b[49:57])
	return h, nil
}

// deriveKey derives a 32-byte AES-256 key from a passphrase and salt via
// argon2id, matching the password-hashing conventions used elsewhere in Cairn.
func deriveKey(passphrase string, salt []byte) []byte {
	return argon2.IDKey([]byte(passphrase), salt, 1, 64*1024, 4, 32)
}

func newNonce() ([]byte, error) {
	n := make([]byte, nonceSize)
	if _, err := io.ReadFull(rand.Reader, n); err != nil {
		return nil, err
	}
	return n, nil
}

// payloadSink writes one stored payload. Plaintext is hashed and optionally
// gzip'd into a temp file as it arrives; Materialize then streams the temp
// content (through AES-256-CTR when encryption is enabled) into the final
// destination with the fixed header (and nonce) in front. Sizes are known
// before the header is written because CTR does not expand data, which keeps
// the whole path streaming with bounded memory.
type payloadSink struct {
	tmp       *os.File
	hasher    hash.Hash
	gz        *gzip.Writer
	compress  bool
	encrypted bool
	key       []byte
	nonce     []byte
	nbytes    int64
}

// newPayloadSink prepares a sink. compress applies deterministic gzip (no mtime)
// so byte-identical unchanged files are hard-linkable across backups; encrypted
// requires a 32-byte key.
func newPayloadSink(compress, encrypted bool, key []byte) (*payloadSink, error) {
	tmp, err := os.CreateTemp("", "cairn-payload-*")
	if err != nil {
		return nil, fmt.Errorf("create payload temp file: %w", err)
	}
	s := &payloadSink{
		tmp:       tmp,
		hasher:    sha256.New(),
		compress:  compress,
		encrypted: encrypted,
		key:       key,
	}
	if compress {
		s.gz = gzip.NewWriter(tmp)
		s.gz.ModTime = time.Time{}
	}
	return s, nil
}

// Write accepts plaintext.
func (s *payloadSink) Write(p []byte) (int, error) {
	if _, err := s.hasher.Write(p); err != nil {
		return 0, err
	}
	s.nbytes += int64(len(p))
	if s.gz != nil {
		return s.gz.Write(p)
	}
	return s.tmp.Write(p)
}

// Materialize writes the finalized payload into dst and returns the header for
// the manifest. It must be called exactly once; the temp file is removed.
func (s *payloadSink) Materialize(dst io.Writer) (fileHeader, error) {
	if s.gz != nil {
		if err := s.gz.Close(); err != nil {
			return fileHeader{}, fmt.Errorf("flush gzip: %w", err)
		}
	}
	stat, err := s.tmp.Stat()
	if err != nil {
		return fileHeader{}, err
	}
	storedSize := stat.Size()
	if s.encrypted {
		nonce, err := newNonce()
		if err != nil {
			return fileHeader{}, err
		}
		s.nonce = nonce
	}

	h := fileHeader{
		Compressed:    s.compress,
		Encrypted:     s.encrypted,
		SHA256Hex:     hex.EncodeToString(s.hasher.Sum(nil)),
		PlaintextSize: uint64(s.nbytes),
		StoredSize:    uint64(storedSize),
	}
	if _, err := dst.Write(h.encode()); err != nil {
		return fileHeader{}, err
	}
	if s.encrypted {
		if _, err := dst.Write(s.nonce); err != nil {
			return fileHeader{}, err
		}
	}

	if _, err := s.tmp.Seek(0, io.SeekStart); err != nil {
		return fileHeader{}, err
	}

	var stream cipher.Stream
	if s.encrypted {
		block, err := aes.NewCipher(s.key)
		if err != nil {
			return fileHeader{}, err
		}
		stream = cipher.NewCTR(block, s.nonce)
	}

	if stream == nil {
		if _, err := io.Copy(dst, bufio.NewReader(s.tmp)); err != nil {
			return fileHeader{}, err
		}
	} else {
		var buf [64 * 1024]byte
		for {
			n, rerr := s.tmp.Read(buf[:])
			if n > 0 {
				sealed := make([]byte, n)
				stream.XORKeyStream(sealed, buf[:n])
				if _, werr := dst.Write(sealed); werr != nil {
					return fileHeader{}, werr
				}
			}
			if rerr == io.EOF {
				break
			}
			if rerr != nil {
				return fileHeader{}, rerr
			}
		}
	}

	if err := os.Remove(s.tmp.Name()); err != nil {
		return fileHeader{}, fmt.Errorf("remove payload temp: %w", err)
	}
	return h, nil
}

// idempotentCleanup lets callers remove the temp file on error paths.
func (s *payloadSink) abort() {
	_ = os.Remove(s.tmp.Name())
}

// payloadReader streams a stored payload back into plaintext, verifying the
// SHA-256 and sizes as it goes. StoredSize serves as an integrity check against
// truncation; the hash catches corruption.
type payloadReader struct {
	body io.Reader
	gz   *gzip.Reader
	h    fileHeader
	sum  hash.Hash
	read int64
	end  int64

	done bool
	err  error
}

// openPayload validates the header and prepares the reader. key may be nil
// unless the payload is encrypted.
func openPayload(r io.Reader, key []byte) (*payloadReader, error) {
	head := make([]byte, headerSize)
	if _, err := io.ReadFull(r, head); err != nil {
		return nil, fmt.Errorf("read payload header: %w", err)
	}
	h, err := decodeHeader(head)
	if err != nil {
		return nil, err
	}
	if h.Encrypted {
		if len(key) == 0 || len(key) != 32 {
			return nil, errors.New("encrypted backup payload but no key available")
		}
		nonce := make([]byte, nonceSize)
		if _, err := io.ReadFull(r, nonce); err != nil {
			return nil, fmt.Errorf("read nonce: %w", err)
		}
		block, err := aes.NewCipher(key)
		if err != nil {
			return nil, err
		}
		r = cipher.StreamReader{S: cipher.NewCTR(block, nonce), R: r}
	}

	pr := &payloadReader{
		h:    h,
		sum:  sha256.New(),
		end:  int64(h.StoredSize),
		body: r,
	}
	if h.Compressed {
		pr.gz, err = gzip.NewReader(r)
		if err != nil {
			return nil, fmt.Errorf("open gzip payload: %w", err)
		}
	}
	return pr, nil
}

// Read returns decrypted, decompressed plaintext.
func (pr *payloadReader) Read(p []byte) (int, error) {
	if pr.done {
		return 0, io.EOF
	}
	var n int
	var err error
	if pr.gz != nil {
		n, err = pr.gz.Read(p)
	} else {
		n, err = pr.body.Read(p)
	}
	if n > 0 {
		_, _ = pr.sum.Write(p[:n])
		pr.read += int64(n)
	}
	if err == io.EOF {
		pr.finish()
	}
	return n, err
}

// finish validates completeness and integrity.
func (pr *payloadReader) finish() {
	defer func() { pr.done = true }()
	if pr.read != int64(pr.h.PlaintextSize) {
		pr.err = fmt.Errorf("payload size mismatch: got %d, header %d", pr.read, pr.h.PlaintextSize)
		return
	}
	if got := hex.EncodeToString(pr.sum.Sum(nil)); got != pr.h.SHA256Hex {
		pr.err = fmt.Errorf("payload checksum mismatch: got %s, header %s", got, pr.h.SHA256Hex)
	}
}

// Err returns a verification error when the payload was corrupt or truncated.
func (pr *payloadReader) Err() error {
	if pr.err != nil {
		return pr.err
	}
	return nil
}

// Header exposes the stored file header for reporting.
func (pr *payloadReader) Header() fileHeader { return pr.h }
