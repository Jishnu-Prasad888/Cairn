package backups

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Destination kinds.
const (
	KindLocal = "local"
	KindSFTP  = "sftp"
	KindFTP   = "ftp"
	KindSMB   = "smb"
)

// FTP security modes.
const (
	FTPSecurityNone     = "none"
	FTPSecurityExplicit = "explicit" // AUTH TLS on the normal port
	FTPSecurityImplicit = "implicit" // TLS from the first byte (usually port 990)
)

// Destination says where backups are written. It is administrator-editable
// and stored in the server database; Password and PrivateKey are stored
// sealed (see secrets.go) and never returned by the API.
type Destination struct {
	Kind string `json:"kind"`

	// Path is the absolute directory for a local destination, or the folder
	// on the remote side (relative to the login's home when not absolute; for
	// SMB, relative to the share).
	Path string `json:"path"`

	Host     string `json:"host,omitempty"`
	Port     int    `json:"port,omitempty"`
	Username string `json:"username,omitempty"`
	Password string `json:"-"`

	// PrivateKey is a PEM-encoded SSH private key (SFTP only).
	PrivateKey string `json:"-"`
	// HostKey pins the SFTP server's key as an OpenSSH SHA256 fingerprint. It
	// is recorded from the first successful connection when left empty.
	HostKey string `json:"host_key,omitempty"`

	Share  string `json:"share,omitempty"`  // SMB share name
	Domain string `json:"domain,omitempty"` // SMB/NTLM domain

	// Security selects FTP transport security: none, explicit or implicit.
	Security string `json:"security,omitempty"`
	// InsecureSkipVerify accepts any FTPS certificate (self-signed NAS boxes).
	InsecureSkipVerify bool `json:"insecure_skip_verify,omitempty"`

	// MountPoint, for a local destination on a mounted drive, is the mount the
	// path must be on. Backups refuse to run while it is not mounted, so an
	// unplugged drive never fills the system disk through the empty mountpoint
	// directory. Set automatically when the destination is saved.
	MountPoint string `json:"mount_point,omitempty"`
}

// Configured reports whether backups have somewhere to go.
func (d Destination) Configured() bool {
	if d.Kind == KindLocal || d.Kind == "" {
		return d.Path != ""
	}
	return d.Host != ""
}

func (d Destination) defaultPort() int {
	switch d.Kind {
	case KindSFTP:
		return 22
	case KindFTP:
		if d.Security == FTPSecurityImplicit {
			return 990
		}
		return 21
	case KindSMB:
		return 445
	}
	return 0
}

func (d Destination) port() int {
	if d.Port > 0 {
		return d.Port
	}
	return d.defaultPort()
}

func (d Destination) addr() string {
	return net.JoinHostPort(d.Host, strconv.Itoa(d.port()))
}

// Key identifies the destination's root for matching backup records to it. It
// carries no secrets. Local destinations use the absolute path.
func (d Destination) Key() string {
	if d.Kind == KindLocal || d.Kind == "" {
		return d.Path
	}
	u := url.URL{Scheme: d.Kind, Host: d.addr()}
	if d.Username != "" {
		u.User = url.User(d.Username)
	}
	p := d.Path
	if d.Kind == KindSMB {
		p = strings.Trim(d.Share+"/"+strings.TrimPrefix(p, "/"), "/")
	}
	u.Path = "/" + strings.TrimPrefix(p, "/")
	return u.String()
}

// Location is the human-readable location of one backup folder.
func (d Destination) Location(folder string) string {
	if d.Kind == KindLocal || d.Kind == "" {
		return filepath.Join(d.Path, folder)
	}
	return strings.TrimSuffix(d.Key(), "/") + "/" + folder
}

// Normalize trims and validates the destination, filling defaults.
func (d Destination) Normalize() (Destination, error) {
	d.Kind = strings.ToLower(strings.TrimSpace(d.Kind))
	if d.Kind == "" {
		d.Kind = KindLocal
	}
	d.Host = strings.TrimSpace(d.Host)
	d.Username = strings.TrimSpace(d.Username)
	d.Share = strings.Trim(strings.TrimSpace(d.Share), `/\`)
	d.Domain = strings.TrimSpace(d.Domain)
	d.HostKey = strings.TrimSpace(d.HostKey)
	if d.Port < 0 || d.Port > 65535 {
		return d, errors.New("port must be between 1 and 65535")
	}
	switch d.Kind {
	case KindLocal:
		d.Path = strings.TrimSpace(d.Path)
		if d.Path != "" {
			if !filepath.IsAbs(d.Path) {
				return d, errors.New("backup directory must be an absolute path")
			}
			d.Path = filepath.Clean(d.Path)
		}
		d.Host, d.Port, d.Username, d.Password, d.PrivateKey = "", 0, "", "", ""
		d.HostKey, d.Share, d.Domain, d.Security, d.InsecureSkipVerify = "", "", "", "", false
		return d, nil
	case KindSFTP, KindFTP, KindSMB:
	default:
		return d, fmt.Errorf("unknown destination kind %q", d.Kind)
	}
	d.MountPoint = ""
	d.Path = cleanRemoteBase(d.Path)
	if d.Host == "" {
		return d, errors.New("host is required")
	}
	if strings.ContainsAny(d.Host, "/ ") {
		return d, errors.New("host must be a host name or address, not a URL")
	}
	switch d.Kind {
	case KindSFTP:
		if d.Username == "" {
			return d, errors.New("username is required for SFTP")
		}
		d.Share, d.Domain, d.Security, d.InsecureSkipVerify = "", "", "", false
	case KindFTP:
		switch d.Security {
		case "":
			d.Security = FTPSecurityExplicit
		case FTPSecurityNone, FTPSecurityExplicit, FTPSecurityImplicit:
		default:
			return d, fmt.Errorf("unknown FTP security %q", d.Security)
		}
		if d.Username == "" {
			d.Username = "anonymous"
		}
		d.PrivateKey, d.HostKey, d.Share, d.Domain = "", "", "", ""
	case KindSMB:
		if d.Share == "" {
			return d, errors.New("share is required for SMB")
		}
		if d.Username == "" {
			return d, errors.New("username is required for SMB")
		}
		d.PrivateKey, d.HostKey, d.Security, d.InsecureSkipVerify = "", "", "", false
	}
	return d, nil
}

// dialTimeout bounds connecting to a remote destination.
const dialTimeout = 20 * time.Second

// openTarget connects to the destination. Connection failures wrap
// ErrUnavailable. onHostKey, when non-nil, receives an SFTP server's
// fingerprint on first contact (HostKey empty) so it can be pinned.
func openTarget(ctx context.Context, d Destination, onHostKey func(string)) (Target, error) {
	switch d.Kind {
	case KindLocal, "":
		if d.Path == "" {
			return nil, errors.New("backup directory not configured; set one on the Backups page")
		}
		if err := checkMounted(d); err != nil {
			return nil, err
		}
		return newLocalTarget(d.Path), nil
	case KindSFTP:
		return openSFTP(ctx, d, onHostKey)
	case KindFTP:
		return openFTP(ctx, d)
	case KindSMB:
		return openSMB(ctx, d)
	}
	return nil, fmt.Errorf("unknown destination kind %q", d.Kind)
}

// unavailable wraps a connection error as ErrUnavailable.
func unavailable(what string, err error) error {
	return fmt.Errorf("%w: %s: %v", ErrUnavailable, what, err)
}
