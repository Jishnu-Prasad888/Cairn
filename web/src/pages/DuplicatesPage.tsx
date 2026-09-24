import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { API_BASE, apiGet } from '../api/client';
import type { DuplicateGroup, DuplicatesResponse, Library } from '../api/types';
import { formatBytes } from '../api/types';
import './DuplicatesPage.css';

/** Bytes wasted by keeping every copy except the first in a group. */
function redundantBytes(groups: DuplicateGroup[]): number {
  return groups.reduce((sum, g) => sum + g.size_bytes * (g.files.length - 1), 0);
}

function DuplicateGroupCard({ group }: { group: DuplicateGroup }) {
  const redundant = group.size_bytes * (group.files.length - 1);
  return (
    <section
      className="dup-group"
      aria-label={`Duplicate group ${group.content_hash.slice(0, 12)}`}
    >
      <header className="dup-group-header">
        <h2>
          {group.files.length} identical files · {formatBytes(group.size_bytes)} each ·{' '}
          {formatBytes(redundant)} redundant
        </h2>
        <code title={group.content_hash}>{group.content_hash.slice(0, 16)}…</code>
      </header>
      <ul className="dup-members">
        {group.files.map((f) => (
          <li key={f.id} className="dup-member">
            {f.media_type === 'photo' ? (
              <img
                className="dup-thumb"
                src={`${API_BASE}/libraries/${f.library_id}/files/${f.id}/thumbnail`}
                alt=""
                loading="lazy"
              />
            ) : (
              <span className="dup-thumb dup-thumb-placeholder" aria-hidden="true">
                {f.media_type.charAt(0).toUpperCase()}
              </span>
            )}
            <span className="dup-member-info">
              <span className="dup-member-name">{f.name}</span>
              <span className="dup-member-path">{f.folder_path || 'Library root'}</span>
            </span>
            <span className="dup-member-size">{formatBytes(f.size_bytes)}</span>
            <a
              className="dup-member-action"
              href={`${API_BASE}/libraries/${f.library_id}/files/${f.id}/download`}
            >
              Download
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

type DuplicatesState =
  | { kind: 'loading' }
  | { kind: 'ok'; total: number; groups: DuplicateGroup[] }
  | { kind: 'error'; message: string };

/** Fetches and renders duplicate groups for a single library. Remounted (via
 * the key prop) whenever the library changes so the state resets naturally. */
function DuplicateGroupList({ libraryId }: { libraryId: string }) {
  const [state, setState] = useState<DuplicatesState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    apiGet<DuplicatesResponse>(`/libraries/${libraryId}/files/duplicates`)
      .then((resp) => {
        if (cancelled) return;
        setState({ kind: 'ok', total: resp.total ?? 0, groups: resp.groups ?? [] });
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setState({ kind: 'error', message: e.message });
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId]);

  if (state.kind === 'error') {
    return (
      <p className="error-text" role="alert">
        {state.message}
      </p>
    );
  }

  if (state.kind === 'loading') {
    return <p className="muted">Scanning for duplicates…</p>;
  }

  if (state.groups.length === 0) {
    return (
      <div className="duplicates-empty" data-testid="duplicates-empty">
        <p className="muted">No duplicates found — every file has unique content.</p>
      </div>
    );
  }

  return (
    <>
      <p className="duplicates-summary" data-testid="duplicates-summary">
        {state.total} duplicate {state.total === 1 ? 'group' : 'groups'} across this library ·{' '}
        {formatBytes(redundantBytes(state.groups))} redundant
      </p>
      <div className="duplicate-groups">
        {state.groups.map((g) => (
          <DuplicateGroupCard key={g.content_hash} group={g} />
        ))}
      </div>
    </>
  );
}

export default function DuplicatesPage() {
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the library list; default to the first usable one.
  useEffect(() => {
    let cancelled = false;
    apiGet<{ libraries: Library[] }>('/libraries')
      .then((resp) => {
        if (cancelled) return;
        const libs = resp.libraries ?? [];
        setLibraries(libs);
        setError(null);
        if (libs.length > 0) {
          setLibraryId((prev) => prev ?? libs[0]!.id);
        }
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setLibraries([]);
        setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (libraries === null) {
    return (
      <main className="duplicates-page">
        <p className="muted">Loading libraries…</p>
      </main>
    );
  }

  if (libraries.length === 0) {
    return (
      <div className="page-muted">
        No libraries yet. Add a library from the server to scan for duplicates.
      </div>
    );
  }

  return (
    <main className="duplicates-page">
      <header className="page-header">
        <h1>Duplicates</h1>
        <div className="header-controls">
          <Link to="/">Home</Link>
          <select
            aria-label="Library"
            value={libraryId ?? ''}
            onChange={(e) => setLibraryId(e.target.value)}
          >
            {libraries.map((lib) => (
              <option key={lib.id} value={lib.id}>
                {lib.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      {libraryId && <DuplicateGroupList key={libraryId} libraryId={libraryId} />}
    </main>
  );
}
