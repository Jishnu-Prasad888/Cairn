package backups

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// server_settings rows owned by backups. Each value is JSON. A stored row
// wins over the CAIRN_BACKUP_* environment defaults.
const (
	dirKey         = "backup.dir" // legacy: a local directory only
	destinationKey = "backup.destination"
	scheduleKey    = "backup.schedule"
	lastFireKey    = "backup.schedule.last_fire"
	triggersKey    = "backup.triggers"
)

// storedDestination is the persisted form of a Destination: secrets sealed.
type storedDestination struct {
	Destination
	PasswordSealed   string `json:"password_sealed,omitempty"`
	PrivateKeySealed string `json:"private_key_sealed,omitempty"`
}

type storedSchedule struct {
	Schedule
	Anchor time.Time `json:"anchor"`
}

func (m *Manager) getSetting(ctx context.Context, key string, v any) (bool, error) {
	var raw string
	err := m.db.QueryRowContext(ctx, `SELECT value FROM server_settings WHERE key = ?`, key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal([]byte(raw), v); err != nil {
		return false, fmt.Errorf("setting %s: %w", key, err)
	}
	return true, nil
}

func (m *Manager) putSetting(ctx context.Context, key string, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = m.db.ExecContext(ctx, `
		INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		key, string(raw), time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

// Load applies the stored backup policy, if an administrator set one, and
// fails records a previous server process left running.
func (m *Manager) Load(ctx context.Context) error {
	var sd storedDestination
	ok, err := m.getSetting(ctx, destinationKey, &sd)
	if err != nil {
		return err
	}
	if ok {
		d := sd.Destination
		if d.Password, err = m.secrets.open(sd.PasswordSealed); err != nil {
			m.logger.Warn("backup destination password unavailable", "error", err)
		}
		if d.PrivateKey, err = m.secrets.open(sd.PrivateKeySealed); err != nil {
			m.logger.Warn("backup destination private key unavailable", "error", err)
		}
		m.mu.Lock()
		m.dest = d
		m.mu.Unlock()
	} else {
		var dir string
		ok, err := m.getSetting(ctx, dirKey, &dir)
		if err != nil {
			return err
		}
		if ok {
			m.mu.Lock()
			m.dest = Destination{Kind: KindLocal, Path: dir, MountPoint: MountPointFor(dir)}
			m.mu.Unlock()
		}
	}

	var ss storedSchedule
	if ok, err := m.getSetting(ctx, scheduleKey, &ss); err != nil {
		return err
	} else if ok {
		m.mu.Lock()
		m.schedule, m.anchor = ss.Schedule, ss.Anchor
		m.mu.Unlock()
	}
	var last time.Time
	if ok, err := m.getSetting(ctx, lastFireKey, &last); err != nil {
		return err
	} else if ok {
		m.mu.Lock()
		m.lastFire = last
		m.mu.Unlock()
	}
	var tr Triggers
	if ok, err := m.getSetting(ctx, triggersKey, &tr); err != nil {
		return err
	} else if ok {
		m.mu.Lock()
		m.triggers = tr
		m.mu.Unlock()
	}

	if n, err := m.store.MarkInterrupted(ctx); err != nil {
		return err
	} else if n > 0 {
		m.logger.Warn("marked interrupted backups as failed", "count", n)
	}
	return nil
}

// SetDir sets a local destination directory; an empty dir disables backups.
// Kept for the original settings endpoint.
func (m *Manager) SetDir(ctx context.Context, dir string) error {
	_, err := m.SetDestination(ctx, DestinationUpdate{Destination: Destination{Kind: KindLocal, Path: dir}})
	return err
}

// DestinationUpdate is an administrator's edit. Password and PrivateKey are
// pointers so an edit can leave a stored secret as it is (nil), clear it
// (""), or replace it.
type DestinationUpdate struct {
	Destination
	Password   *string
	PrivateKey *string
	// ForgetHostKey drops the pinned SFTP host key so the next save pins
	// whatever the server presents (after a server is reinstalled).
	ForgetHostKey bool
}

// SetDestination validates, tests, stores and applies a new destination.
//
// A local directory is created if missing and must be writable and outside
// every library root, so the indexer never picks backups up as media; when it
// sits on a mounted drive that mount is remembered, and later runs wait for
// the drive instead of writing to the empty mountpoint. A remote destination
// is connected to and written once before it is accepted; an SFTP server's
// host key is pinned on that first connection.
func (m *Manager) SetDestination(ctx context.Context, u DestinationUpdate) (Destination, error) {
	cur := m.Destination()
	d, err := m.resolve(u).Normalize()
	if err != nil {
		return cur, err
	}

	if d.Kind == KindLocal && d.Path != "" {
		if err := m.checkLocalDir(ctx, d.Path); err != nil {
			return cur, err
		}
		d.MountPoint = MountPointFor(d.Path)
	} else if d.Kind != KindLocal {
		if err := m.probe(ctx, &d); err != nil {
			return cur, err
		}
	}

	sd := storedDestination{Destination: d}
	if sd.PasswordSealed, err = m.secrets.seal(d.Password); err != nil {
		return cur, fmt.Errorf("store password: %w", err)
	}
	if sd.PrivateKeySealed, err = m.secrets.seal(d.PrivateKey); err != nil {
		return cur, fmt.Errorf("store private key: %w", err)
	}
	if err := m.putSetting(ctx, destinationKey, sd); err != nil {
		return cur, err
	}
	// Keep the legacy row in step so an older binary still finds a local dir.
	if d.Kind == KindLocal {
		if err := m.putSetting(ctx, dirKey, d.Path); err != nil {
			return cur, err
		}
	}
	m.mu.Lock()
	m.dest = d
	m.mu.Unlock()
	m.logger.Info("backup destination changed", "kind", d.Kind, "location", d.Key(), "mount_point", d.MountPoint)
	m.Nudge()
	return d, nil
}

// TestDestination connects to a destination and writes a probe file without
// saving anything. It returns the destination as it would be stored, with an
// SFTP host key filled in on first contact.
func (m *Manager) TestDestination(ctx context.Context, u DestinationUpdate) (Destination, error) {
	d, err := m.resolve(u).Normalize()
	if err != nil {
		return d, err
	}
	if d.Kind == KindLocal {
		if d.Path == "" {
			return d, errors.New("choose a folder")
		}
		if err := m.checkLocalDir(ctx, d.Path); err != nil {
			return d, err
		}
		d.MountPoint = MountPointFor(d.Path)
		return d, nil
	}
	err = m.probe(ctx, &d)
	return d, err
}

// resolve applies an edit over the current destination: secrets and the
// pinned SFTP host key carry over while the server and login stay the same.
func (m *Manager) resolve(u DestinationUpdate) Destination {
	cur := m.Destination()
	d := u.Destination
	d.Password, d.PrivateKey = "", ""
	sameServer := cur.Kind == strings.ToLower(strings.TrimSpace(d.Kind)) &&
		cur.Host == strings.TrimSpace(d.Host) && cur.Username == strings.TrimSpace(d.Username)
	if u.Password != nil {
		d.Password = *u.Password
	} else if sameServer {
		d.Password = cur.Password
	}
	if u.PrivateKey != nil {
		d.PrivateKey = *u.PrivateKey
	} else if sameServer {
		d.PrivateKey = cur.PrivateKey
	}
	if d.HostKey == "" && sameServer && d.Port == cur.Port && !u.ForgetHostKey {
		d.HostKey = cur.HostKey
	}
	return d
}

// checkLocalDir creates a local destination and checks it is usable.
func (m *Manager) checkLocalDir(ctx context.Context, dir string) error {
	libs, err := m.libs.List(ctx)
	if err != nil {
		return err
	}
	for _, l := range libs {
		root := filepath.Clean(l.Root)
		if dir == root || strings.HasPrefix(dir, root+string(filepath.Separator)) {
			return fmt.Errorf("backup directory must not be inside the library %q", l.Name)
		}
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create backup directory: %w", err)
	}
	probe, err := os.CreateTemp(dir, ".cairn-write-test-*")
	if err != nil {
		return fmt.Errorf("backup directory is not writable: %w", err)
	}
	_ = probe.Close()
	_ = os.Remove(probe.Name())
	return nil
}

// probe connects to a remote destination, pins an unknown SFTP host key, and
// round-trips a small file through it.
func (m *Manager) probe(ctx context.Context, d *Destination) error {
	ctx, cancel := context.WithTimeout(ctx, 2*dialTimeout)
	defer cancel()
	tgt, err := m.open(ctx, *d, func(fp string) { d.HostKey = fp })
	if err != nil {
		return err
	}
	defer func() { _ = tgt.Close() }()
	if d.Path != "" {
		if err := tgt.MkdirAll("."); err != nil {
			return fmt.Errorf("create %s: %w", d.Path, err)
		}
	}
	name := fmt.Sprintf(".cairn-write-test-%d", time.Now().UnixNano())
	want := []byte("cairn")
	if err := writeTargetFile(tgt, name, want); err != nil {
		return fmt.Errorf("destination is not writable: %w", err)
	}
	got, err := readTargetFile(tgt, name)
	_ = tgt.Remove(name)
	if err != nil {
		return fmt.Errorf("destination is not readable: %w", err)
	}
	if string(got) != string(want) {
		return errors.New("destination returned different bytes than were written")
	}
	return nil
}

// Schedule returns the current schedule.
func (m *Manager) Schedule() Schedule {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.schedule
}

// SetSchedule validates, stores and applies a schedule. Changing it restarts
// its clock from now; the next run is the first slot after now.
func (m *Manager) SetSchedule(ctx context.Context, s Schedule) (Schedule, error) {
	s, err := s.Normalize()
	if err != nil {
		return m.Schedule(), err
	}
	now := time.Now().UTC()
	m.mu.RLock()
	unchanged := s == m.schedule
	anchor := m.anchor
	m.mu.RUnlock()
	if unchanged && !anchor.IsZero() {
		return s, nil
	}
	if err := m.putSetting(ctx, scheduleKey, storedSchedule{Schedule: s, Anchor: now}); err != nil {
		return m.Schedule(), err
	}
	m.mu.Lock()
	m.schedule, m.anchor = s, now
	m.mu.Unlock()
	m.logger.Info("backup schedule changed", "schedule", s.Describe())
	m.Nudge()
	return s, nil
}

// Triggers returns the current size triggers.
func (m *Manager) Triggers() Triggers {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.triggers
}

// SetTriggers validates, stores and applies the size triggers.
func (m *Manager) SetTriggers(ctx context.Context, t Triggers) (Triggers, error) {
	t, err := t.Normalize()
	if err != nil {
		return m.Triggers(), err
	}
	if err := m.putSetting(ctx, triggersKey, t); err != nil {
		return m.Triggers(), err
	}
	m.mu.Lock()
	m.triggers = t
	m.mu.Unlock()
	m.logger.Info("backup size triggers changed", "single_file_bytes", t.SingleFileBytes, "total_bytes", t.TotalBytes)
	m.Nudge()
	return t, nil
}

// recordFire persists when the schedule last ran, so the rhythm survives a
// restart.
func (m *Manager) recordFire(ctx context.Context, at time.Time) {
	m.mu.Lock()
	m.lastFire = at
	m.mu.Unlock()
	if err := m.putSetting(ctx, lastFireKey, at.UTC()); err != nil {
		m.logger.Warn("persist backup schedule progress", "error", err)
	}
}
