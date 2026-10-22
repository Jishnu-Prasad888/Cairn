package backups

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"strings"

	"github.com/hirochachacha/go-smb2"
)

// smbTarget stores backups on an SMB2/3 share (Windows, Samba, most NAS
// boxes). SMB has no hard links, so incremental runs reference unchanged files
// in earlier backups instead.
type smbTarget struct {
	base    string
	conn    net.Conn
	session *smb2.Session
	share   *smb2.Share
}

func openSMB(ctx context.Context, d Destination) (Target, error) {
	dialer := net.Dialer{Timeout: dialTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", d.addr())
	if err != nil {
		return nil, unavailable("connect to "+d.addr(), err)
	}
	sd := &smb2.Dialer{Initiator: &smb2.NTLMInitiator{
		User:     d.Username,
		Password: d.Password,
		Domain:   d.Domain,
	}}
	session, err := sd.DialContext(ctx, conn)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("SMB login to %s: %w", d.addr(), err)
	}
	share, err := session.Mount(`\\` + d.Host + `\` + d.Share)
	if err != nil {
		_ = session.Logoff()
		_ = conn.Close()
		return nil, fmt.Errorf("mount SMB share %q: %w", d.Share, err)
	}
	return &smbTarget{base: strings.Trim(d.Path, "/"), conn: conn, session: session, share: share}, nil
}

// abs converts a target path to an SMB path: backslashes, relative to the
// share root, never leading with a separator.
func (t *smbTarget) abs(p string) string {
	full := strings.Trim(joinRemote(t.base, p), "/")
	return strings.ReplaceAll(full, "/", `\`)
}

func (t *smbTarget) MkdirAll(p string) error { return t.share.MkdirAll(t.abs(p), 0o700) }

func (t *smbTarget) Create(p string) (io.WriteCloser, error) { return t.share.Create(t.abs(p)) }

func (t *smbTarget) Open(p string) (io.ReadCloser, error) { return t.share.Open(t.abs(p)) }

func (t *smbTarget) Size(p string) (int64, error) {
	fi, err := t.share.Stat(t.abs(p))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return 0, err
		}
		return 0, notExist(p, err)
	}
	return fi.Size(), nil
}

func (t *smbTarget) Remove(p string) error    { return t.share.Remove(t.abs(p)) }
func (t *smbTarget) RemoveAll(p string) error { return t.share.RemoveAll(t.abs(p)) }

func (t *smbTarget) Close() error {
	err := t.share.Umount()
	_ = t.session.Logoff()
	_ = t.conn.Close()
	return err
}
