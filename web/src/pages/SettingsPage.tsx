/**
 * Settings — account, appearance, and the administrator's corner.
 *
 * The previous version confirmed session revocation with `window.confirm`,
 * which a screen reader announces as a bare question with no context and which
 * cannot be styled. It is a {@link ConfirmDialog} now.
 *
 * The admin section also used to be the only place accounts were manageable
 * from, with no route to the other upkeep surfaces. Those are linked here so
 * the settings page is the place someone lands when they want "the admin
 * things", even though each has its own page.
 */

import { type FormEvent, useCallback, useState } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/authContext';
import { useResource } from '../api/resources';
import { createUser, listUsers, revokeUserSessions } from '../api/queries';
import type { User, UserRole } from '../api/types';
import Brand from '../components/Brand';
import { ConfirmDialog } from '../components/Dialog';
import { PageHeader } from '../components/States';
import { type ThemePreference, readStoredTheme, storeTheme } from '../lib/theme';
import './SettingsPage.css';

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'Match system' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [theme, setTheme] = useState<ThemePreference>(() => readStoredTheme());

  const users = useResource<User[]>(
    useCallback(async () => (await listUsers()).users ?? [], []),
    [],
    isAdmin,
  );

  const [revoking, setRevoking] = useState<User | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('user');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const onThemeChange = (next: ThemePreference) => {
    setTheme(next);
    storeTheme(next);
  };

  const confirmRevoke = () => {
    if (!revoking) return;
    setRevokeBusy(true);
    setRevokeError(null);
    revokeUserSessions(revoking.id)
      .then(() => {
        setRevoking(null);
        users.reload();
      })
      .catch((e: unknown) => setRevokeError(message(e)))
      .finally(() => setRevokeBusy(false));
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    const name = newUsername.trim();
    if (name === '' || newPassword === '') {
      setCreateError('Enter a username and a password.');
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    setCreated(null);
    createUser({ username: name, password: newPassword, role: newRole })
      .then((resp) => {
        setCreated(`Created ${resp.user.username}.`);
        setNewUsername('');
        setNewPassword('');
        setNewRole('user');
        users.reload();
      })
      .catch((e: unknown) => setCreateError(message(e)))
      .finally(() => setCreateBusy(false));
  };

  return (
    <main className="settings-page">
      <PageHeader
        title="Settings"
        subtitle="Your account, how Cairn looks, and the upkeep tasks you have access to."
      />

      <section className="settings-card" aria-labelledby="settings-account">
        <h2 id="settings-account">Account</h2>
        <div className="settings-account">
          <span className="settings-avatar" aria-hidden="true">
            {(user?.username ?? '?').slice(0, 1).toUpperCase()}
          </span>
          <div className="settings-account-meta">
            <strong>{user?.username}</strong>
            <span className="settings-role" data-role={user?.role}>
              {user?.role === 'admin' ? 'Administrator' : 'Member'}
            </span>
            {user && <span className="muted">Joined {formatDate(user.created_at)}</span>}
          </div>
          <button type="button" className="button danger-button" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </section>

      <section className="settings-card" aria-labelledby="settings-appearance">
        <h2 id="settings-appearance">Appearance</h2>
        <p className="muted settings-hint">
          Cairn keeps its palette; this only chooses between the light and dark appearances already
          defined by the theme.
        </p>
        <div className="settings-themes" role="radiogroup" aria-label="Theme">
          {THEME_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={theme === option.value ? 'settings-theme active' : 'settings-theme'}
            >
              <input
                type="radio"
                name="theme"
                value={option.value}
                checked={theme === option.value}
                onChange={() => onThemeChange(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="settings-card" aria-labelledby="settings-tools">
        <h2 id="settings-tools">Organize</h2>
        <p className="muted settings-hint">
          Everything below works on the library you have selected in the header.
        </p>
        <ul className="settings-links">
          <li>
            <Link className="button" to="/tags">
              Tags
            </Link>
            <span className="muted">Labels you apply to media, and where to browse by them.</span>
          </li>
          <li>
            <Link className="button" to="/albums">
              Albums
            </Link>
            <span className="muted">Curated groups of photos and videos.</span>
          </li>
          <li>
            <Link className="button" to="/memories">
              Memories
            </Link>
            <span className="muted">Markdown notes about your media.</span>
          </li>
          <li>
            <Link className="button" to="/people">
              People
            </Link>
            <span className="muted">Face grouping, if the server supports it.</span>
          </li>
          <li>
            <Link className="button" to="/sharing">
              Sharing
            </Link>
            <span className="muted">Public links to albums and files.</span>
          </li>
          <li>
            <Link className="button" to="/duplicates">
              Duplicates
            </Link>
            <span className="muted">Files with identical contents.</span>
          </li>
        </ul>
      </section>

      {isAdmin ? (
        <>
          <section className="settings-card" aria-labelledby="settings-accounts">
            <h2 id="settings-accounts">Accounts</h2>
            {users.error && (
              <p className="error-text" role="alert">
                {users.error}
              </p>
            )}
            {users.loading && !users.error && <p className="muted">Loading accounts…</p>}
            {users.data !== null && users.data.length === 0 && (
              <p className="muted">No accounts yet.</p>
            )}
            {users.data !== null && users.data.length > 0 && (
              <ul className="settings-user-list" data-testid="settings-user-list">
                {users.data.map((row) => (
                  <li key={row.id} className="settings-user-row">
                    <span className="settings-user-name">
                      {row.username}
                      {row.id === user?.id && <span className="muted"> (you)</span>}
                    </span>
                    <span className="settings-role" data-role={row.role}>
                      {row.role === 'admin' ? 'Administrator' : 'Member'}
                    </span>
                    <span className="muted settings-user-date">{formatDate(row.created_at)}</span>
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        setRevokeError(null);
                        setRevoking(row);
                      }}
                    >
                      Revoke sessions
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <form className="settings-create" onSubmit={(e) => void create(e)}>
              <h3>Add an account</h3>
              <div className="settings-create-fields">
                <input
                  className="settings-input"
                  type="text"
                  placeholder="Username"
                  aria-label="New username"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  disabled={createBusy}
                />
                <input
                  className="settings-input"
                  type="password"
                  placeholder="Password"
                  aria-label="New password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  disabled={createBusy}
                />
                <select
                  className="settings-input"
                  aria-label="New account role"
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as UserRole)}
                  disabled={createBusy}
                >
                  <option value="user">Member</option>
                  <option value="admin">Administrator</option>
                </select>
                <button type="submit" className="button" disabled={createBusy}>
                  {createBusy ? 'Creating…' : 'Create account'}
                </button>
              </div>
              {createError && (
                <p className="error-text" role="alert">
                  {createError}
                </p>
              )}
              {created && (
                <p className="settings-created" role="status">
                  {created}
                </p>
              )}
            </form>
          </section>

          <section className="settings-card" aria-labelledby="settings-admin">
            <h2 id="settings-admin">Server upkeep</h2>
            <p className="muted settings-hint">
              Administrator-only. These are the tasks that touch the whole server rather than one
              library.
            </p>
            <ul className="settings-links">
              <li>
                <Link className="button" to="/libraries">
                  Libraries
                </Link>
                <span className="muted">
                  Register, reconnect, re-index, and unregister storage.
                </span>
              </li>
              <li>
                <Link className="button" to="/permissions">
                  Permissions
                </Link>
                <span className="muted">Who can read, write, and manage each library.</span>
              </li>
              <li>
                <Link className="button" to="/ml">
                  Machine learning
                </Link>
                <span className="muted">Similarity passes and visual search.</span>
              </li>
              <li>
                <Link className="button" to="/backups">
                  Backups
                </Link>
                <span className="muted">Take, verify, and restore a metadata snapshot.</span>
              </li>
            </ul>
          </section>
        </>
      ) : (
        <section className="settings-card" aria-labelledby="settings-access">
          <h2 id="settings-access">Access</h2>
          <p className="muted">
            Your account can browse and organize the libraries you have been given. Library
            administration is limited to administrators.
          </p>
        </section>
      )}

      <ConfirmDialog
        open={revoking !== null}
        title="Sign this account out everywhere?"
        confirmLabel="Revoke sessions"
        busy={revokeBusy}
        error={revokeError}
        message={
          <p>
            <strong>{revoking?.username}</strong> will be signed out of every device and browser.
            They will need to sign in again.
          </p>
        }
        onCancel={() => setRevoking(null)}
        onConfirm={confirmRevoke}
        testId="revoke-sessions-dialog"
      />

      <footer className="settings-footer">
        <p className="muted">
          <Brand>Cairn</Brand> — your files are never moved or modified.
        </p>
      </footer>
    </main>
  );
}
