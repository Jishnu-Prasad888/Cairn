package backups

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"

	"github.com/jlaffaye/ftp"
)

// ftpTarget stores backups on an FTP or FTPS server. FTP has no hard links,
// so incremental runs reference unchanged files in earlier backups instead.
//
// An FTP control connection carries one transfer at a time; the backup writer
// is sequential, so one connection is enough.
type ftpTarget struct {
	base string
	conn *ftp.ServerConn
}

func openFTP(ctx context.Context, d Destination) (Target, error) {
	opts := []ftp.DialOption{ftp.DialWithTimeout(dialTimeout), ftp.DialWithContext(ctx)}
	if d.Security != FTPSecurityNone {
		tc := &tls.Config{ServerName: d.Host, InsecureSkipVerify: d.InsecureSkipVerify, MinVersion: tls.VersionTLS12} //nolint:gosec // opt-in for self-signed NAS certificates
		if d.Security == FTPSecurityImplicit {
			opts = append(opts, ftp.DialWithTLS(tc))
		} else {
			opts = append(opts, ftp.DialWithExplicitTLS(tc))
		}
	}
	conn, err := ftp.Dial(d.addr(), opts...)
	if err != nil {
		return nil, unavailable("connect to "+d.addr(), err)
	}
	if err := conn.Login(d.Username, d.Password); err != nil {
		_ = conn.Quit()
		return nil, fmt.Errorf("FTP login to %s: %w", d.addr(), err)
	}
	if err := conn.Type(ftp.TransferTypeBinary); err != nil {
		_ = conn.Quit()
		return nil, fmt.Errorf("FTP binary mode: %w", err)
	}
	return &ftpTarget{base: d.Path, conn: conn}, nil
}

func (t *ftpTarget) abs(p string) string { return joinRemote(t.base, p) }

// MkdirAll creates each missing component. FTP reports "exists" and "denied"
// with the same reply code, so per-component errors are ignored and a real
// failure surfaces on the first write into the folder.
func (t *ftpTarget) MkdirAll(p string) error {
	full := t.abs(p)
	cur := ""
	if strings.HasPrefix(full, "/") {
		cur = "/"
	}
	for _, part := range strings.Split(strings.Trim(full, "/"), "/") {
		if part == "" || part == "." {
			continue
		}
		cur = path.Join(cur, part)
		_ = t.conn.MakeDir(cur)
	}
	return nil
}

// Create streams the file to the server through a pipe: STOR runs until the
// writer is closed.
func (t *ftpTarget) Create(p string) (io.WriteCloser, error) {
	pr, pw := io.Pipe()
	done := make(chan error, 1)
	go func() {
		err := t.conn.Stor(t.abs(p), pr)
		// Unblock a writer still pushing data after a failed STOR.
		_ = pr.CloseWithError(errors.Join(err, io.ErrClosedPipe))
		done <- err
	}()
	return &ftpWriter{pw: pw, done: done}, nil
}

type ftpWriter struct {
	pw   *io.PipeWriter
	done chan error
}

func (w *ftpWriter) Write(b []byte) (int, error) { return w.pw.Write(b) }

func (w *ftpWriter) Close() error {
	_ = w.pw.Close()
	return <-w.done
}

func (t *ftpTarget) Open(p string) (io.ReadCloser, error) {
	r, err := t.conn.Retr(t.abs(p))
	if err != nil {
		return nil, notExist(p, err)
	}
	return r, nil
}

// Size uses SIZE, which needs binary mode (set at login). Servers that do not
// implement SIZE make every file look missing; that only disables pruning of
// partially referenced folders, never data.
func (t *ftpTarget) Size(p string) (int64, error) {
	n, err := t.conn.FileSize(t.abs(p))
	if err != nil {
		return 0, notExist(p, err)
	}
	return n, nil
}

func (t *ftpTarget) Remove(p string) error { return t.conn.Delete(t.abs(p)) }

func (t *ftpTarget) RemoveAll(p string) error {
	if err := t.conn.RemoveDirRecur(t.abs(p)); err != nil {
		// Already gone is success; anything else is reported.
		if _, lerr := t.conn.List(t.abs(p)); lerr != nil {
			return nil
		}
		return err
	}
	return nil
}

func (t *ftpTarget) Close() error { return t.conn.Quit() }
