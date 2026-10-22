package backups

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// startSFTPServer runs an in-process SSH server with the sftp subsystem,
// accepting user "cairn" / password "secret". It returns the address and the
// server's host key fingerprint.
func startSFTPServer(t *testing.T) (string, string) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &ssh.ServerConfig{
		PasswordCallback: func(c ssh.ConnMetadata, pass []byte) (*ssh.Permissions, error) {
			if c.User() == "cairn" && string(pass) == "secret" {
				return nil, nil
			}
			return nil, errors.New("denied")
		},
	}
	cfg.AddHostKey(signer)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go serveSSH(conn, cfg)
		}
	}()
	return ln.Addr().String(), ssh.FingerprintSHA256(signer.PublicKey())
}

func serveSSH(conn net.Conn, cfg *ssh.ServerConfig) {
	_, chans, reqs, err := ssh.NewServerConn(conn, cfg)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(reqs)
	for nc := range chans {
		if nc.ChannelType() != "session" {
			_ = nc.Reject(ssh.UnknownChannelType, "session only")
			continue
		}
		ch, in, err := nc.Accept()
		if err != nil {
			continue
		}
		go func() {
			for req := range in {
				ok := req.Type == "subsystem" && len(req.Payload) > 4 && string(req.Payload[4:]) == "sftp"
				_ = req.Reply(ok, nil)
				if ok {
					srv, err := sftp.NewServer(ch)
					if err == nil {
						_ = srv.Serve()
					}
					_ = ch.Close()
					return
				}
			}
		}()
	}
}

func TestSFTPDestinationEndToEnd(t *testing.T) {
	addr, fingerprint := startSFTPServer(t)
	host, portStr, _ := net.SplitHostPort(addr)
	var port int
	for _, c := range portStr {
		port = port*10 + int(c-'0')
	}
	remote := filepath.Join(t.TempDir(), "remote", "cairn")

	pool, serverPath := tempServerDB(t)
	ctx := context.Background()
	lib := registerLibrary(t, newLibraryManager(pool), filepath.Join(t.TempDir(), "papa"))
	m := newManager(t, pool, serverPath, "", "", 4)
	m.secrets = newSecretBox(t.TempDir())

	wrong := "nope"
	if _, err := m.SetDestination(ctx, DestinationUpdate{
		Destination: Destination{Kind: KindSFTP, Host: host, Port: port, Username: "cairn", Path: remote},
		Password:    &wrong,
	}); err == nil {
		t.Fatal("bad password accepted")
	}

	pw := "secret"
	d, err := m.SetDestination(ctx, DestinationUpdate{
		Destination: Destination{Kind: KindSFTP, Host: host, Port: port, Username: "cairn", Path: remote},
		Password:    &pw,
	})
	if err != nil {
		t.Fatalf("set sftp destination: %v", err)
	}
	if d.HostKey != fingerprint {
		t.Fatalf("pinned host key = %q, want %q", d.HostKey, fingerprint)
	}

	first, err := m.Run(ctx)
	if err != nil || first.Status != StatusCompleted {
		t.Fatalf("sftp backup: %v %+v", err, first)
	}
	if first.Target != d.Key() || first.VerifyStatus != VerifyOK {
		t.Fatalf("record = target %q verify %q", first.Target, first.VerifyStatus)
	}
	rel := filepath.Join("libraries", lib.ID, "files", "holiday", "beach.jpg")
	stored := filepath.Join(remote, recordFolder(*first), rel)
	if _, err := os.Stat(stored); err != nil {
		t.Fatalf("payload not on the sftp server: %v", err)
	}

	// The second run hard-links through the OpenSSH extension.
	second, err := m.Run(ctx)
	if err != nil || second.Status != StatusCompleted || second.FilesSkipped != 1 {
		t.Fatalf("incremental sftp backup: %v %+v", err, second)
	}
	a, _ := os.Stat(stored)
	b, err := os.Stat(filepath.Join(remote, recordFolder(*second), rel))
	if err != nil || !os.SameFile(a, b) {
		t.Fatalf("unchanged file not hard-linked over sftp (err %v)", err)
	}

	out := t.TempDir()
	if _, err := m.Restore(ctx, second.ID, out); err != nil {
		t.Fatalf("restore from sftp: %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join(out, rel)); string(got) != "jpeg-bytes-that-are-descriptive-enough" {
		t.Fatalf("restored = %q", got)
	}

	// A different host key is refused, and not as a retryable outage.
	m.mu.Lock()
	m.dest.HostKey = "SHA256:somethingelse"
	m.mu.Unlock()
	_, err = m.Run(ctx)
	if !errors.Is(err, ErrHostKeyMismatch) || errors.Is(err, ErrUnavailable) {
		t.Fatalf("host key mismatch err = %v", err)
	}
}
