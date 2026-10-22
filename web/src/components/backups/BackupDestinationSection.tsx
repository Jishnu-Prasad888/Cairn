/**
 * Where backups go: a folder on the server (an internal disk or a mounted
 * drive), or an SFTP, FTP or SMB server.
 *
 * A local folder is saved as soon as it is valid. A remote destination is
 * tested first — the server connects and writes a probe file — and the save
 * itself repeats that test, so a destination that cannot be written to is
 * never stored. Passwords and keys are write-only: the server only says
 * whether one is stored, and leaving the field blank keeps it.
 */

import { type FormEvent, useState } from 'react';

import { setBackupDestination, setBackupDir, testBackupDestination } from '../../api/queries';
import type {
  BackupDestination,
  BackupDestinationInput,
  BackupDestinationKind,
  BackupDrive,
  BackupSettings,
} from '../../api/types';
import { formatBytes } from '../../api/types';
import ServerFolderBrowser, { FolderOpenIcon } from '../ServerFolderBrowser';
import { destinationConfigured, savedDestination } from './backupSettings';
import './BackupSettings.css';

const KINDS: { value: BackupDestinationKind; label: string }[] = [
  { value: 'local', label: 'Folder or drive' },
  { value: 'sftp', label: 'SFTP' },
  { value: 'ftp', label: 'FTP' },
  { value: 'smb', label: 'SMB share' },
];

const DEFAULT_PORT: Record<BackupDestinationKind, string> = {
  local: '',
  sftp: '22',
  ftp: '21',
  smb: '445',
};

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function BackupDestinationSection({
  settings,
  drives,
  onSaved,
}: {
  settings: BackupSettings;
  drives: BackupDrive[] | null;
  onSaved: (next: BackupSettings) => void;
}) {
  const saved = savedDestination(settings);
  const [kind, setKind] = useState<BackupDestinationKind>(saved.kind);

  return (
    <section className="backup-settings-section" aria-labelledby="backup-folder-title">
      <div className="backup-settings-heading">
        <h2 id="backup-folder-title">Destination</h2>
        <div className="segmented" role="group" aria-label="Destination type">
          {KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              className="segmented-item"
              aria-pressed={kind === k.value}
              onClick={() => setKind(k.value)}
              data-testid={`backup-kind-${k.value}`}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>
      {!destinationConfigured(settings) && (
        <p className="muted backups-warning" data-testid="backup-folder-missing">
          No backup destination is set, so backups cannot run. Choose a folder on another disk, a
          USB drive, or a server on your network.
        </p>
      )}
      {kind === 'local' ? (
        <LocalFolderForm settings={settings} drives={drives} onSaved={onSaved} />
      ) : (
        <RemoteForm key={kind} kind={kind} saved={saved} onSaved={onSaved} />
      )}
    </section>
  );
}

/** A folder on the server; it is created if missing and must not be inside a library. */
function LocalFolderForm({
  settings,
  drives,
  onSaved,
}: {
  settings: BackupSettings;
  drives: BackupDrive[] | null;
  onSaved: (next: BackupSettings) => void;
}) {
  const saved = savedDestination(settings);
  const savedDir = saved.kind === 'local' ? saved.path : '';
  const [dir, setDir] = useState(savedDir);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);

  const saveDir = (target: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setBackupDir(target)
      .then((next) => {
        // The server cleans the path; show what it actually stored.
        setDir(next.destination?.path ?? next.dir);
        onSaved(next);
        setNotice(target ? 'Backup folder saved.' : 'Backups disabled.');
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    saveDir(dir.trim());
  };

  const pickable = (drives ?? []).filter((d) => !d.system);

  return (
    <>
      <form className="backup-folder-form" onSubmit={save}>
        <label className="field">
          <span className="field-label">Folder on the server</span>
          <input
            type="text"
            value={dir}
            placeholder="/mnt/backup-disk/cairn"
            onChange={(e) => {
              setDir(e.target.value);
              setNotice(null);
            }}
            disabled={busy}
            data-testid="backup-folder-input"
          />
        </label>
        <button
          type="button"
          className="button backup-folder-browse"
          onClick={() => setBrowsing((open) => !open)}
          aria-expanded={browsing}
          disabled={busy}
          title="Browse folders on the server"
          data-testid="backup-folder-browse"
        >
          <FolderOpenIcon />
          <span>Browse</span>
        </button>
        <button
          type="submit"
          className="button"
          disabled={busy || (dir.trim() === savedDir && saved.kind === 'local')}
          data-testid="backup-folder-save"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>
      {browsing && (
        <ServerFolderBrowser
          start={dir.trim().startsWith('/') ? dir.trim() : ''}
          onChoose={(chosen) => {
            // Choosing a folder is the whole intent, so save it straight away.
            setDir(chosen);
            setBrowsing(false);
            saveDir(chosen);
          }}
          onCancel={() => setBrowsing(false)}
        />
      )}
      {pickable.length > 0 && (
        <div className="backup-drives" data-testid="backup-drives">
          <span className="field-label">Mounted drives</span>
          <ul>
            {pickable.map((d) => (
              <li key={d.path}>
                <button
                  type="button"
                  className="backup-drive"
                  onClick={() => {
                    setDir(`${d.path.replace(/\/$/, '')}/cairn-backups`);
                    setNotice(null);
                  }}
                  disabled={busy}
                  title={`Back up to ${d.path}`}
                >
                  <span className="backup-drive-path">{d.path}</span>
                  <span className="backup-drive-meta">
                    {d.network ? 'Network' : d.removable ? 'Removable' : 'Disk'} · {d.fs_type}
                    {d.total_bytes > 0 &&
                      ` · ${formatBytes(d.free_bytes)} free of ${formatBytes(d.total_bytes)}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="muted backup-folder-hint">
        An absolute path. It is created if missing and must not be inside a library.
        {saved.kind === 'local' && saved.mount_point
          ? ` It is on the drive mounted at ${saved.mount_point}: while that drive is unplugged, backups wait and run once it is back.`
          : ''}
      </p>
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

interface RemoteFields {
  host: string;
  port: string;
  username: string;
  password: string;
  path: string;
  privateKey: string;
  share: string;
  domain: string;
  security: 'none' | 'explicit' | 'implicit';
  insecure: boolean;
}

function initialFields(kind: BackupDestinationKind, saved: BackupDestination): RemoteFields {
  const same = saved.kind === kind;
  return {
    host: same ? (saved.host ?? '') : '',
    port: same && saved.port ? String(saved.port) : '',
    username: same ? (saved.username ?? '') : '',
    password: '',
    path: same ? saved.path : 'cairn-backups',
    privateKey: '',
    share: same ? (saved.share ?? '') : '',
    domain: same ? (saved.domain ?? '') : '',
    security: same && saved.security ? saved.security : 'explicit',
    insecure: same ? Boolean(saved.insecure_skip_verify) : false,
  };
}

function RemoteForm({
  kind,
  saved,
  onSaved,
}: {
  kind: Exclude<BackupDestinationKind, 'local'>;
  saved: BackupDestination;
  onSaved: (next: BackupSettings) => void;
}) {
  const [f, setF] = useState<RemoteFields>(() => initialFields(kind, saved));
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hostKey, setHostKey] = useState<string>(saved.kind === kind ? (saved.host_key ?? '') : '');
  const [forgetKey, setForgetKey] = useState(false);

  // A stored secret belongs to one server and login; it carries over only
  // while those stay the same.
  const sameLogin =
    saved.kind === kind && saved.host === f.host.trim() && saved.username === f.username.trim();
  const passwordStored = sameLogin && saved.password_set;
  const keyStored = sameLogin && saved.private_key_set;

  const set = <K extends keyof RemoteFields>(k: K, v: RemoteFields[K]) => {
    setF((prev) => ({ ...prev, [k]: v }));
    setNotice(null);
  };

  const input = (): BackupDestinationInput => {
    const out: BackupDestinationInput = {
      kind,
      host: f.host.trim(),
      username: f.username.trim(),
      path: f.path.trim(),
    };
    if (f.port.trim()) out.port = Number(f.port);
    if (f.password) out.password = f.password;
    if (kind === 'sftp') {
      if (f.privateKey.trim()) out.private_key = f.privateKey;
      if (forgetKey) out.forget_host_key = true;
      else if (sameLogin && hostKey) out.host_key = hostKey;
    }
    if (kind === 'smb') {
      out.share = f.share.trim();
      out.domain = f.domain.trim();
    }
    if (kind === 'ftp') {
      out.security = f.security;
      out.insecure_skip_verify = f.insecure;
    }
    return out;
  };

  const test = () => {
    setBusy('test');
    setError(null);
    setNotice(null);
    testBackupDestination(input())
      .then((res) => {
        if (!res.ok) {
          setError(res.error ?? 'The destination could not be reached.');
          return;
        }
        const fp = res.destination.host_key;
        setNotice(
          kind === 'sftp' && fp && fp !== hostKey
            ? `Connected and wrote a test file. The server's key is ${fp} — check it matches your server before saving.`
            : 'Connected and wrote a test file.',
        );
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(null));
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    setBusy('save');
    setError(null);
    setNotice(null);
    setBackupDestination(input())
      .then((next) => {
        setF((prev) => ({ ...prev, password: '', privateKey: '' }));
        setHostKey(next.destination?.host_key ?? '');
        setForgetKey(false);
        onSaved(next);
        setNotice('Destination saved.');
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(null));
  };

  const disabled = busy !== null;
  return (
    <form className="backup-remote-form" onSubmit={save} data-testid="backup-remote-form">
      <div className="backup-remote-grid">
        <label className="field backup-remote-host">
          <span className="field-label">Server</span>
          <input
            type="text"
            value={f.host}
            placeholder="nas.local or 192.168.1.20"
            onChange={(e) => set('host', e.target.value)}
            disabled={disabled}
            required
            autoComplete="off"
            data-testid="backup-remote-host"
          />
        </label>
        <label className="field backup-remote-port">
          <span className="field-label">Port</span>
          <input
            type="number"
            min={1}
            max={65535}
            value={f.port}
            placeholder={kind === 'ftp' && f.security === 'implicit' ? '990' : DEFAULT_PORT[kind]}
            onChange={(e) => set('port', e.target.value)}
            disabled={disabled}
          />
        </label>
        {kind === 'smb' && (
          <label className="field">
            <span className="field-label">Share</span>
            <input
              type="text"
              value={f.share}
              placeholder="backups"
              onChange={(e) => set('share', e.target.value)}
              disabled={disabled}
              required
              data-testid="backup-remote-share"
            />
          </label>
        )}
        <label className="field">
          <span className="field-label">Username</span>
          <input
            type="text"
            value={f.username}
            placeholder={kind === 'ftp' ? 'anonymous' : ''}
            onChange={(e) => set('username', e.target.value)}
            disabled={disabled}
            required={kind !== 'ftp'}
            autoComplete="off"
            data-testid="backup-remote-username"
          />
        </label>
        <label className="field">
          <span className="field-label">
            {kind === 'sftp' ? 'Password or key passphrase' : 'Password'}
          </span>
          <input
            type="password"
            value={f.password}
            placeholder={passwordStored ? 'Stored — leave blank to keep' : ''}
            onChange={(e) => set('password', e.target.value)}
            disabled={disabled}
            autoComplete="new-password"
            data-testid="backup-remote-password"
          />
        </label>
        {kind === 'smb' && (
          <label className="field">
            <span className="field-label">Domain (optional)</span>
            <input
              type="text"
              value={f.domain}
              placeholder="WORKGROUP"
              onChange={(e) => set('domain', e.target.value)}
              disabled={disabled}
            />
          </label>
        )}
        <label className="field backup-remote-path">
          <span className="field-label">
            {kind === 'smb' ? 'Folder in the share' : 'Folder on the server'}
          </span>
          <input
            type="text"
            value={f.path}
            placeholder={kind === 'smb' ? 'cairn' : '/volume1/backups/cairn'}
            onChange={(e) => set('path', e.target.value)}
            disabled={disabled}
            data-testid="backup-remote-path"
          />
        </label>
        {kind === 'ftp' && (
          <label className="field">
            <span className="field-label">Security</span>
            <select
              value={f.security}
              onChange={(e) => set('security', e.target.value as RemoteFields['security'])}
              disabled={disabled}
            >
              <option value="explicit">FTPS (explicit TLS)</option>
              <option value="implicit">FTPS (implicit TLS)</option>
              <option value="none">None — plain FTP</option>
            </select>
          </label>
        )}
      </div>

      {kind === 'sftp' && (
        <label className="field">
          <span className="field-label">Private key (optional)</span>
          <textarea
            className="backup-remote-key"
            value={f.privateKey}
            rows={3}
            spellCheck={false}
            placeholder={
              keyStored
                ? 'A key is stored — leave blank to keep it'
                : '-----BEGIN OPENSSH PRIVATE KEY-----'
            }
            onChange={(e) => set('privateKey', e.target.value)}
            disabled={disabled}
          />
        </label>
      )}
      {kind === 'sftp' && hostKey && sameLogin && (
        <p className="muted backup-folder-hint" data-testid="backup-host-key">
          Trusted server key <code>{hostKey}</code>.{' '}
          {forgetKey ? (
            'The key the server presents on save will be trusted instead.'
          ) : (
            <button
              type="button"
              className="link-button"
              onClick={() => setForgetKey(true)}
              disabled={disabled}
            >
              Trust a new key
            </button>
          )}
        </p>
      )}
      {kind === 'ftp' && f.security === 'none' && (
        <p className="muted backups-warning">
          Plain FTP sends your password and every file unencrypted over the network. Use it only on
          a network you trust, and consider setting a backup passphrase.
        </p>
      )}
      {kind === 'ftp' && f.security !== 'none' && (
        <label className="backup-checkbox">
          <input
            type="checkbox"
            checked={f.insecure}
            onChange={(e) => set('insecure', e.target.checked)}
            disabled={disabled}
          />
          <span>Accept a self-signed certificate</span>
        </label>
      )}

      <div className="backup-form-actions">
        <button
          type="button"
          className="button"
          onClick={test}
          disabled={disabled || !f.host.trim()}
          data-testid="backup-remote-test"
        >
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        <button
          type="submit"
          className="button primary-button"
          disabled={disabled || !f.host.trim()}
          data-testid="backup-remote-save"
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
      </div>
      <p className="muted backup-folder-hint">
        {kind === 'sftp'
          ? 'Unchanged files are hard-linked on servers that support it (OpenSSH does), so each backup is complete but only new files take space.'
          : 'Unchanged files are not uploaded again: later backups point at the copy an earlier backup already made.'}{' '}
        If the server is unreachable when a backup is due, it is retried every few minutes.
      </p>
      {notice && (
        <p className="muted" role="status" data-testid="backup-remote-notice">
          {notice}
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
