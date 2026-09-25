import { type FormEvent, useCallback, useEffect, useState } from 'react';

import { apiGet, apiPost } from '../api/client';
import type { User, UserListResponse, UserRole } from '../api/types';
import { useAuth } from '../auth/authContext';
import Brand from '../components/Brand';
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

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [theme, setTheme] = useState<ThemePreference>(() => readStoredTheme());

  const [users, setUsers] = useState<User[] | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [revokeBusy, setRevokeBusy] = useState<string | null>(null);

  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('user');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const loadUsers = useCallback(() => {
    apiGet<UserListResponse>('/users')
      .then((resp) => {
        setUsers(resp.users ?? []);
        setUsersError(null);
      })
      .catch((e: Error) => setUsersError(e.message));
  }, []);

  useEffect(() => {
    if (isAdmin) loadUsers();
  }, [isAdmin, loadUsers]);

  const onThemeChange = (next: ThemePreference) => {
    setTheme(next);
    storeTheme(next);
  };

  const revokeSessions = async (target: User) => {
    if (!window.confirm(`Sign ${target.username} out of all devices?`)) return;
    setRevokeBusy(target.id);
    setUsersError(null);
    try {
      await apiPost(`/users/${target.id}/sessions/revoke`);
      loadUsers();
    } catch (e: unknown) {
      setUsersError(e instanceof Error ? e.message : String(e));
    } finally {
      setRevokeBusy(null);
    }
  };

  const createUser = async (event: FormEvent) => {
    event.preventDefault();
    const name = newUsername.trim();
    if (name === '' || newPassword === '') {
      setCreateError('Enter a username and a password.');
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    setCreated(null);
    try {
      const resp = await apiPost<{ user: User }>('/users', {
        username: name,
        password: newPassword,
        role: newRole,
      });
      setCreated(`Created ${resp.user.username}.`);
      setNewUsername('');
      setNewPassword('');
      setNewRole('user');
      loadUsers();
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreateBusy(false);
    }
  };

  return (
    <main className="settings-page">
      <header className="page-header">
        <h1>Settings</h1>
      </header>

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

      {isAdmin && (
        <section className="settings-card" aria-labelledby="settings-accounts">
          <h2 id="settings-accounts">Accounts</h2>
          {usersError && (
            <p className="error-text" role="alert">
              {usersError}
            </p>
          )}
          {users === null && !usersError && <p className="muted">Loading accounts…</p>}
          {users !== null && users.length === 0 && <p className="muted">No accounts yet.</p>}
          {users !== null && users.length > 0 && (
            <ul className="settings-user-list" data-testid="settings-user-list">
              {users.map((row) => (
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
                    onClick={() => void revokeSessions(row)}
                    disabled={revokeBusy === row.id}
                  >
                    {revokeBusy === row.id ? 'Signing out…' : 'Revoke sessions'}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form className="settings-create" onSubmit={(e) => void createUser(e)}>
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
      )}

      {!isAdmin && (
        <section className="settings-card" aria-labelledby="settings-access">
          <h2 id="settings-access">Access</h2>
          <p className="muted">
            Your account can browse and organize the libraries you have been given. Library
            administration is limited to administrators.
          </p>
        </section>
      )}

      <footer className="settings-footer">
        <p className="muted">
          <Brand>Cairn</Brand> — your files are never moved or modified.
        </p>
      </footer>
    </main>
  );
}
