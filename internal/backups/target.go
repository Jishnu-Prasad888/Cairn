package backups

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Target is where backups are stored: a local (possibly mounted) directory or
// a remote SFTP, FTP or SMB location. Every path is slash-separated and
// relative to the target's root; implementations translate it.
//
// A backup is written as one folder per run directly under the root, so the
// operations needed are small: make folders, write and read whole files, stat,
// remove, and (where the protocol allows it) hard-link for incremental runs.
type Target interface {
	MkdirAll(p string) error
	// Create opens p for writing, truncating any existing file. The write is
	// only complete once Close returns nil.
	Create(p string) (io.WriteCloser, error)
	Open(p string) (io.ReadCloser, error)
	// Size reports a file's size, or an error wrapping fs.ErrNotExist.
	Size(p string) (int64, error)
	Remove(p string) error
	RemoveAll(p string) error
	Close() error
}

// linker is implemented by targets that can hard-link one stored file to
// another path (local filesystems that support it, SFTP with the OpenSSH
// hardlink extension). Unchanged files are then linked rather than referenced.
type linker interface {
	Link(oldPath, newPath string) error
}

// ErrUnavailable marks a destination that cannot be reached right now: a
// backup drive that is not mounted, or a remote host that refused the
// connection. A scheduled or triggered run waiting on it retries later instead
// of recording a failed backup.
var ErrUnavailable = errors.New("backup destination unavailable")

// localTarget stores backups in a directory on the server's own filesystem —
// an internal disk or a mounted drive.
type localTarget struct {
	root string
}

func newLocalTarget(root string) *localTarget { return &localTarget{root: root} }

func (t *localTarget) abs(p string) string {
	return filepath.Join(t.root, filepath.FromSlash(p))
}

func (t *localTarget) MkdirAll(p string) error { return os.MkdirAll(t.abs(p), 0o700) }

func (t *localTarget) Create(p string) (io.WriteCloser, error) {
	return os.OpenFile(t.abs(p), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
}

func (t *localTarget) Open(p string) (io.ReadCloser, error) { return os.Open(t.abs(p)) }

func (t *localTarget) Size(p string) (int64, error) {
	fi, err := os.Stat(t.abs(p))
	if err != nil {
		return 0, err
	}
	return fi.Size(), nil
}

func (t *localTarget) Remove(p string) error    { return os.Remove(t.abs(p)) }
func (t *localTarget) RemoveAll(p string) error { return os.RemoveAll(t.abs(p)) }
func (t *localTarget) Close() error             { return nil }

func (t *localTarget) Link(oldPath, newPath string) error {
	return os.Link(t.abs(oldPath), t.abs(newPath))
}

// mkdirParent creates the parent folder of a target path.
func mkdirParent(t Target, p string) error {
	dir := path.Dir(p)
	if dir == "." || dir == "/" {
		return nil
	}
	return t.MkdirAll(dir)
}

// writeTargetFile writes data to p in one go.
func writeTargetFile(t Target, p string, data []byte) error {
	if err := mkdirParent(t, p); err != nil {
		return err
	}
	w, err := t.Create(p)
	if err != nil {
		return err
	}
	if _, err := w.Write(data); err != nil {
		_ = w.Close()
		return err
	}
	return w.Close()
}

// readTargetFile reads all of p.
func readTargetFile(t Target, p string) ([]byte, error) {
	r, err := t.Open(p)
	if err != nil {
		return nil, err
	}
	defer func() { _ = r.Close() }()
	return io.ReadAll(r)
}

// exists reports whether p is present on the target.
func exists(t Target, p string) bool {
	_, err := t.Size(p)
	return err == nil
}

// countingWriter counts the bytes passed through to w.
type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

// ReadFrom keeps fast paths (sftp's concurrent writes, copy_file_range) when
// the underlying writer has one.
func (c *countingWriter) ReadFrom(r io.Reader) (int64, error) {
	if rf, ok := c.w.(io.ReaderFrom); ok {
		n, err := rf.ReadFrom(r)
		c.n += n
		return n, err
	}
	n, err := io.Copy(struct{ io.Writer }{c.w}, r)
	c.n += n
	return n, err
}

// joinRemote joins a configured remote base path and a target-relative path.
// An empty base means the login's home/default directory.
func joinRemote(base, p string) string {
	if base == "" {
		return p
	}
	return path.Join(base, p)
}

// cleanRemoteBase normalises a remote base directory as typed by a person.
func cleanRemoteBase(p string) string {
	p = strings.TrimSpace(strings.ReplaceAll(p, `\`, "/"))
	if p == "" {
		return ""
	}
	abs := strings.HasPrefix(p, "/")
	p = path.Clean(p)
	if p == "." {
		return ""
	}
	if !abs {
		p = strings.TrimPrefix(p, "/")
	}
	return p
}

// notExist wraps an error so errors.Is(err, fs.ErrNotExist) holds.
func notExist(p string, err error) error {
	return fmt.Errorf("%s: %w (%v)", p, fs.ErrNotExist, err)
}
