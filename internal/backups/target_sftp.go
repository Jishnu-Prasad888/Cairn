package backups

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"strings"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// sftpTarget stores backups over SFTP (SSH). Hard links use the OpenSSH
// hardlink@openssh.com extension, so incremental runs cost no extra space on
// an OpenSSH server.
type sftpTarget struct {
	base   string
	ssh    *ssh.Client
	client *sftp.Client
}

// ErrHostKeyMismatch is returned when an SFTP server presents a key other
// than the pinned one.
var ErrHostKeyMismatch = errors.New("SFTP host key does not match the pinned key")

func openSFTP(ctx context.Context, d Destination, onHostKey func(string)) (Target, error) {
	var auths []ssh.AuthMethod
	if strings.TrimSpace(d.PrivateKey) != "" {
		var (
			signer ssh.Signer
			err    error
		)
		if d.Password != "" {
			// A password alongside a key is taken as the key's passphrase
			// first; if the key is not encrypted it is offered as a login
			// password below as well.
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(d.PrivateKey), []byte(d.Password))
			if err != nil {
				signer, err = ssh.ParsePrivateKey([]byte(d.PrivateKey))
			}
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(d.PrivateKey))
		}
		if err != nil {
			return nil, fmt.Errorf("SFTP private key: %w", err)
		}
		auths = append(auths, ssh.PublicKeys(signer))
	}
	if d.Password != "" {
		auths = append(auths, ssh.Password(d.Password))
	}
	if len(auths) == 0 {
		return nil, errors.New("SFTP needs a password or a private key")
	}

	var mismatch error
	cfg := &ssh.ClientConfig{
		User:    d.Username,
		Auth:    auths,
		Timeout: dialTimeout,
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			got := ssh.FingerprintSHA256(key)
			if d.HostKey == "" {
				if onHostKey == nil {
					mismatch = errors.New("SFTP host key is not pinned; save the destination again to trust it")
					return mismatch
				}
				onHostKey(got)
				return nil
			}
			if got != d.HostKey {
				mismatch = fmt.Errorf("%w: server presented %s, expected %s", ErrHostKeyMismatch, got, d.HostKey)
				return mismatch
			}
			return nil
		},
	}

	dialer := net.Dialer{Timeout: dialTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", d.addr())
	if err != nil {
		return nil, unavailable("connect to "+d.addr(), err)
	}
	sc, chans, reqs, err := ssh.NewClientConn(conn, d.addr(), cfg)
	if err != nil {
		_ = conn.Close()
		if mismatch != nil {
			// A changed host key is a security event, not an outage: never
			// retry it silently.
			return nil, mismatch
		}
		return nil, fmt.Errorf("SFTP login to %s: %w", d.addr(), err)
	}
	client := ssh.NewClient(sc, chans, reqs)
	sf, err := sftp.NewClient(client, sftp.UseConcurrentWrites(true), sftp.UseConcurrentReads(true))
	if err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("start SFTP session: %w", err)
	}
	return &sftpTarget{base: d.Path, ssh: client, client: sf}, nil
}

func (t *sftpTarget) abs(p string) string { return joinRemote(t.base, p) }

func (t *sftpTarget) MkdirAll(p string) error { return t.client.MkdirAll(t.abs(p)) }

func (t *sftpTarget) Create(p string) (io.WriteCloser, error) {
	return t.client.OpenFile(t.abs(p), os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
}

func (t *sftpTarget) Open(p string) (io.ReadCloser, error) { return t.client.Open(t.abs(p)) }

func (t *sftpTarget) Size(p string) (int64, error) {
	fi, err := t.client.Stat(t.abs(p))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return 0, err
		}
		return 0, notExist(p, err)
	}
	return fi.Size(), nil
}

func (t *sftpTarget) Remove(p string) error { return t.client.Remove(t.abs(p)) }

func (t *sftpTarget) RemoveAll(p string) error {
	if _, err := t.client.Stat(t.abs(p)); errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return t.client.RemoveAll(t.abs(p))
}

func (t *sftpTarget) Link(oldPath, newPath string) error {
	return t.client.Link(t.abs(oldPath), t.abs(newPath))
}

func (t *sftpTarget) Close() error {
	err := t.client.Close()
	if cerr := t.ssh.Close(); err == nil {
		err = cerr
	}
	return err
}
