/**
 * Small presentational building blocks shared by every page: the page frame,
 * library selector, status badges, and the loading/empty/error states.
 *
 * These existed as ad-hoc markup and CSS per page, which is why the layout
 * drifted and why an offline library was invisible instead of explained.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useLibraries } from '../api/libraries';
import type { Library, LibraryStatus } from '../api/types';
import './States.css';

/** The `page-header` + `h1` + `header-controls` frame every page uses. */
export function PageHeader({
  title,
  subtitle,
  controls,
}: {
  title: string;
  subtitle?: ReactNode;
  controls?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header-titles">
        <h1>{title}</h1>
        {subtitle && <p className="muted page-header-subtitle">{subtitle}</p>}
      </div>
      {controls && <div className="header-controls">{controls}</div>}
    </header>
  );
}

/**
 * The library picker. Shows an explicit "Offline" marker for libraries whose
 * storage is unreachable so a user can tell an empty library from a
 * disconnected disk.
 */
export function LibrarySelect({
  label = 'Library',
  value,
  onChange,
  includeOffline = true,
}: {
  label?: string;
  value: string | null;
  onChange: (id: string) => void;
  includeOffline?: boolean;
}) {
  const { libraries } = useLibraries();
  const visible = includeOffline
    ? libraries
    : libraries.filter((lib) => lib.status !== 'offline');

  if (visible.length === 0) return null;

  return (
    <select aria-label={label} value={value ?? ''} onChange={(event) => onChange(event.target.value)}>
      {visible.map((lib) => (
        <option key={lib.id} value={lib.id}>
          {lib.name}
          {lib.status === 'offline' ? ' (offline)' : ''}
        </option>
      ))}
    </select>
  );
}

/** A connected/disconnected pill for a library's storage. */
export function LibraryStatusBadge({ status }: { status: LibraryStatus }) {
  const offline = status === 'offline';
  return (
    <span
      className={offline ? 'status-badge status-badge-offline' : 'status-badge status-badge-online'}
      data-testid="library-status"
      data-status={status}
    >
      {offline ? 'Offline' : 'Online'}
    </span>
  );
}

/** A small labelled pill for a media type. */
export function TypeBadge({ children }: { children: ReactNode }) {
  return <span className="type-badge">{children}</span>;
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="muted" role="status">
      {label}
    </p>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <p className="error-text">{message}</p>
      {onRetry && (
        <button type="button" className="button" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
  testId,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="empty-state" data-testid={testId}>
      <h2>{title}</h2>
      {children && <div className="empty-state-body">{children}</div>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}

/**
 * The "no libraries at all" state. Administrators get a route to register one;
 * members are told to ask, because library registration is admin-only.
 */
export function NoLibrariesState({ isAdmin }: { isAdmin: boolean }) {
  return (
    <EmptyState
      title="No libraries yet"
      testId="no-libraries"
      action={
        isAdmin ? (
          <Link className="button primary-button" to="/libraries">
            Add a library
          </Link>
        ) : undefined
      }
    >
      <p className="muted">
        Cairn organizes media that already lives on your disk. Point it at a folder of photos,
        videos, or files and it will index them in place — nothing is copied or modified.
      </p>
      {!isAdmin && (
        <p className="muted">
          You have not been given access to a library yet. Ask an administrator to grant you one.
        </p>
      )}
    </EmptyState>
  );
}

/**
 * The "your library's storage is not reachable" state. Distinct from empty:
 * the metadata is still there, the bytes are not.
 */
export function LibraryOfflineNotice({ library }: { library: Library }) {
  return (
    <div className="offline-notice" role="status" data-testid="library-offline">
      <LibraryStatusBadge status="offline" />
      <div>
        <strong>{library.name} is offline.</strong>
        <p className="muted">
          Its storage was last seen at <code>{library.root}</code>. Your tags, albums, and memories
          are safe — reconnect the drive and Cairn will pick up where it left off.
        </p>
      </div>
    </div>
  );
}
