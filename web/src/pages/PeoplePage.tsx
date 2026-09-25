import { useCallback, useEffect, useState } from 'react';

import { API_BASE, apiGet, apiPost, apiDelete } from '../api/client';
import type { FaceStatus, FaceSummary, Library, Person } from '../api/types';
import './PeoplePage.css';

function faceImageUrl(libraryId: string, faceId: string): string {
  return `${API_BASE}/libraries/${libraryId}/faces/${faceId}/image`;
}

interface PeoplePageProps {
  initialLibraryId?: string;
}

export default function PeoplePage({ initialLibraryId }: PeoplePageProps) {
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [libraryId, setLibraryId] = useState<string | null>(initialLibraryId ?? null);
  const [people, setPeople] = useState<Person[]>([]);
  const [faces, setFaces] = useState<FaceSummary[]>([]);
  const [status, setStatus] = useState<FaceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [personFaces, setPersonFaces] = useState<Record<string, FaceSummary[]>>({});

  // Load the library list; default to the first usable one.
  useEffect(() => {
    let cancelled = false;
    apiGet<{ libraries: Library[] }>('/libraries')
      .then((resp) => {
        if (cancelled) return;
        const libs = resp.libraries ?? [];
        setLibraries(libs);
        setLoading(false);
        if (libs.length > 0) {
          const preferred = libs.find((lib) => lib.id === libraryId) ?? libs[0]!;
          setLibraryId(preferred.id);
        }
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback((id: string) => {
    apiGet<FaceStatus>(`/libraries/${id}/ml/faces`)
      .then(async (st) => {
        setStatus(st);
        if (st.enabled) {
          const [p, f] = await Promise.all([
            apiGet<{ people: Person[] }>(`/libraries/${id}/people`),
            apiGet<{ faces: FaceSummary[] }>(`/libraries/${id}/faces`),
          ]);
          setPeople(p.people ?? []);
          setFaces(f.faces ?? []);
          setExpanded((cur) => (cur && p.people?.some((x) => x.id === cur) ? cur : null));
        } else {
          setPeople([]);
          setFaces([]);
        }
      })
      .catch((e: Error) => {
        setError(e.message);
        setStatus(null);
        setPeople([]);
        setFaces([]);
      });
  }, []);

  useEffect(() => {
    if (!libraryId) return;
    load(libraryId);
  }, [libraryId, load]);

  const toggleExpand = async (personId: string) => {
    if (!libraryId) return;
    if (expanded === personId) {
      setExpanded(null);
      return;
    }
    setExpanded(personId);
    if (!personFaces[personId]) {
      try {
        const resp = await apiGet<{ faces: FaceSummary[] }>(
          `/libraries/${libraryId}/people/${personId}`,
        );
        setPersonFaces((prev) => ({ ...prev, [personId]: resp.faces ?? [] }));
      } catch (e) {
        setError((e as Error).message);
      }
    }
  };

  const refresh = () => {
    if (libraryId) load(libraryId);
  };

  const runPass = async (path: string) => {
    if (!libraryId) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/libraries/${libraryId}${path}`);
      setBusy(false);
      // The pass is async; poll status shortly so the UI updates.
      window.setTimeout(refresh, 1200);
    } catch (e) {
      setBusy(false);
      setError((e as Error).message);
    }
  };

  const rename = async (person: Person) => {
    if (!libraryId) return;
    const name = window.prompt('Rename person to:', person.name);
    if (!name || name.trim() === '' || name === person.name) return;
    try {
      await apiPost(`/libraries/${libraryId}/people/${person.id}/rename`, { name: name.trim() });
      setPeople((prev) => prev.map((p) => (p.id === person.id ? { ...p, name: name.trim() } : p)));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const mergeInto = async (target: Person) => {
    if (!libraryId || people.length < 2) return;
    const options = people
      .filter((p) => p.id !== target.id)
      .map((p) => `${p.name} (${p.id})`)
      .join('\n');
    const choice = window.prompt(
      `Merge "${target.name}" into which person? Paste one of these IDs:\n${options}`,
    );
    if (!choice || choice.trim() === '') return;
    try {
      await apiPost(`/libraries/${libraryId}/people/${choice.trim()}/merge`, {
        source_person_id: target.id,
      });
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (person: Person) => {
    if (!libraryId) return;
    if (!window.confirm(`Delete person "${person.name}"? Faces are kept.`)) return;
    try {
      await apiDelete(`/libraries/${libraryId}/people/${person.id}`);
      setPeople((prev) => prev.filter((p) => p.id !== person.id));
      setPersonFaces((prev) => {
        const next = { ...prev };
        delete next[person.id];
        return next;
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const unassign = async (personId: string, faceId: string) => {
    if (!libraryId) return;
    try {
      await apiDelete(`/libraries/${libraryId}/people/${personId}/faces/${faceId}`);
      setPersonFaces((prev) => ({
        ...prev,
        [personId]: (prev[personId] ?? []).filter((f) => f.id !== faceId),
      }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const assignTo = async (faceId: string, personId: string) => {
    if (!libraryId || !personId) return;
    try {
      await apiPost(`/libraries/${libraryId}/people/${personId}/faces/${faceId}`);
      setFaces((prev) => prev.filter((f) => f.id !== faceId));
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (loading) {
    return <div className="page-muted">Loading libraries…</div>;
  }

  if (libraries.length === 0) {
    return (
      <div className="page-muted">
        No libraries yet. Add a library from the server to browse people.
      </div>
    );
  }

  const facesEnabled = Boolean(status?.enabled);

  return (
    <main className="people-page">
      <header className="page-header">
        <h1>People</h1>
        <div className="header-controls">
          <select
            aria-label="Library"
            value={libraryId ?? ''}
            onChange={(e) => {
              setLibraryId(e.target.value);
              setExpanded(null);
            }}
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

      {!facesEnabled ? (
        <div className="people-empty" data-testid="people-disabled">
          <p>
            Face recognition is disabled for this server. Ask an administrator to enable{' '}
            <code>CAIRN_ML_ENABLED</code> and <code>CAIRN_ML_FACES</code>, then run a detection
            pass.
          </p>
        </div>
      ) : (
        <div className="people-toolbar">
          <div className="people-actions">
            <button type="button" disabled={busy} onClick={() => runPass('/ml/faces/pass')}>
              Detect faces
            </button>
            <button type="button" disabled={busy} onClick={() => runPass('/ml/faces/cluster')}>
              Cluster faces
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={busy}
              onClick={async () => {
                if (!libraryId) return;
                if (!window.confirm('Remove all detected faces and groupings? Names are kept.')) {
                  return;
                }
                try {
                  await apiPost(`/libraries/${libraryId}/ml/faces/purge`);
                  refresh();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Purge faces
            </button>
          </div>
          {status && (
            <span className="people-stats">
              {status.faces} faces · {status.people} people · {status.unassigned} unassigned
            </span>
          )}
        </div>
      )}

      {status && status.people > 0 && (
        <section aria-label="Named people">
          <div className="people-grid" data-testid="people-grid">
            {people.map((person) => (
              <article className="person-card" key={person.id}>
                <button
                  type="button"
                  className="person-cover"
                  onClick={() => toggleExpand(person.id)}
                  aria-expanded={expanded === person.id}
                >
                  {person.cover_face_id ? (
                    <img
                      src={faceImageUrl(libraryId!, person.cover_face_id)}
                      alt={`${person.name} cover`}
                      loading="lazy"
                    />
                  ) : (
                    <span className="person-cover-fallback">{person.name.slice(0, 1)}</span>
                  )}
                </button>
                <div className="person-meta">
                  <strong>{person.name}</strong>
                  <span className="person-count">
                    {person.face_count} {person.face_count === 1 ? 'face' : 'faces'}
                  </span>
                </div>
                <div className="person-actions">
                  <button type="button" onClick={() => toggleExpand(person.id)}>
                    {expanded === person.id ? 'Collapse' : 'Faces'}
                  </button>
                  <button type="button" onClick={() => rename(person)}>
                    Rename
                  </button>
                  <button type="button" onClick={() => mergeInto(person)}>
                    Merge
                  </button>
                  <button type="button" className="danger-button" onClick={() => remove(person)}>
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {expanded && personFaces[expanded] && (
        <section className="person-detail" aria-label="Person faces">
          <h2>{people.find((p) => p.id === expanded)?.name ?? 'Person'} faces</h2>
          <div className="face-grid">
            {(personFaces[expanded] ?? []).map((face) => (
              <figure className="face-tile" key={face.id}>
                <img src={faceImageUrl(libraryId!, face.id)} alt="Face" loading="lazy" />
                <figcaption>
                  <button type="button" onClick={() => unassign(expanded, face.id)}>
                    Unassign
                  </button>
                </figcaption>
              </figure>
            ))}
            {(personFaces[expanded] ?? []).length === 0 && (
              <p className="muted">No faces assigned yet.</p>
            )}
          </div>
        </section>
      )}

      {facesEnabled && faces.length > 0 && (
        <section aria-label="Unassigned faces">
          <h2>Unassigned faces</h2>
          <div className="face-grid">
            {faces.map((face) => (
              <figure className="face-tile" key={face.id}>
                <img src={faceImageUrl(libraryId!, face.id)} alt="Unassigned face" loading="lazy" />
                <figcaption>
                  <select
                    aria-label="Assign face to person"
                    value=""
                    onChange={(e) => {
                      if (e.target.value) assignTo(face.id, e.target.value);
                    }}
                  >
                    <option value="" disabled>
                      Assign to…
                    </option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
