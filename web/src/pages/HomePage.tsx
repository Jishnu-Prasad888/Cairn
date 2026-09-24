import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { ApiError, apiGet } from '../api/client';
import type { HealthResponse, VersionResponse } from '../api/types';
import Brand from '../components/Brand';
import './HomePage.css';

interface StatusPaneProps {
  className?: string;
  title: string;
  rows: Array<[string, string]>;
}

function StatusPane({ className, title, rows }: StatusPaneProps) {
  return (
    <section className={`status-pane ${className ?? ''}`} aria-label={title}>
      <h2>{title}</h2>
      <dl>
        {rows.map(([term, detail]) => (
          <div className="status-row" key={term}>
            <dt>{term}</dt>
            <dd>{detail}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

type ServerState =
  | { kind: 'loading' }
  | { kind: 'ok'; health: HealthResponse; version: VersionResponse }
  | { kind: 'error'; message: string };

export default function HomePage() {
  const [state, setState] = useState<ServerState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [health, version] = await Promise.all([
          apiGet<HealthResponse>('/health'),
          apiGet<VersionResponse>('/version'),
        ]);
        if (!cancelled) {
          setState({ kind: 'ok', health, version });
        }
      } catch (error) {
        if (cancelled) return;
        const message =
          error instanceof ApiError ? error.message : 'Could not reach the Cairn server.';
        setState({ kind: 'error', message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const retry = () => {
    setState({ kind: 'loading' });
    setReloadKey((key) => key + 1);
  };

  return (
    <main className="home">
      <header className="home-header">
        <h1>
          <Brand>Cairn</Brand>
        </h1>
        <p className="tagline">Your personal place for files, photos, videos, and memories.</p>
        <nav className="home-nav" aria-label="Sections">
          <Link to="/memories">Memories</Link>
          <Link to="/people">People</Link>
          <Link to="/duplicates">Duplicates</Link>
        </nav>
      </header>

      <div role="status" aria-live="polite" className="home-status">
        {state.kind === 'loading' && <p className="muted">Checking the server…</p>}
        {state.kind === 'error' && (
          <p className="error-text">
            {state.message}{' '}
            <button type="button" className="link-button" onClick={retry}>
              Retry
            </button>
          </p>
        )}
        {state.kind === 'ok' && (
          <div className="status-grid">
            <StatusPane
              title="Server"
              rows={[
                ['Status', state.health.status],
                ['Database', state.health.database],
              ]}
            />
            <StatusPane
              title="Version"
              rows={[
                ['Version', state.version.version],
                ['Commit', state.version.commit],
                ['Built', state.version.build_date],
              ]}
            />
          </div>
        )}
      </div>

      <footer className="home-footer">
        <p className="muted">
          Cairn indexes your media in place — your files are never moved or modified.
        </p>
      </footer>
    </main>
  );
}
