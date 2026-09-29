/**
 * People — the face grouping for a library.
 *
 * Face recognition is optional on the server, so this page has to be honest
 * about three very different states: faces turned off (the `/ml/faces` route
 * 503s), faces unavailable in this build (the route does not exist and 404s),
 * and faces working but empty. All three used to render as the same red
 * sentence with an HTTP status in it.
 *
 * Every destructive action is a dialog rather than `window.confirm`, and the
 * merge target is chosen from a list instead of being pasted as a raw id.
 */

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '../auth/authContext';
import { ApiError } from '../api/client';
import { useLibraryGate } from '../api/libraries';
import { useLibraryResource } from '../api/resources';
import {
  assignFace,
  clusterFaces,
  deletePerson,
  faceImageUrl,
  getFaceStatus,
  getPerson,
  listPeople,
  listUnassignedFaces,
  mergePeople,
  purgeFaces,
  renamePerson,
  runFacePass,
  setPersonCover,
  unassignFace,
} from '../api/queries';
import type { FaceStatus, FaceSummary, Person } from '../api/types';
import { ConfirmDialog, Dialog, PromptDialog } from '../components/Dialog';
import LibraryPicker from '../components/LibraryPicker';
import {
  EmptyState,
  ErrorState,
  LibraryOfflineNotice,
  LoadingState,
  NoLibrariesState,
  PageHeader,
} from '../components/States';
import './PeoplePage.css';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Everything the page renders, fetched together so the counts agree. */
interface PeopleData {
  status: FaceStatus;
  people: Person[];
  unassigned: FaceSummary[];
  /** Set when the server build has no face routes at all. */
  unsupported: boolean;
}

async function loadPeople(libraryId: string): Promise<PeopleData> {
  let status: FaceStatus;
  try {
    status = await getFaceStatus(libraryId);
  } catch (e: unknown) {
    // 503 = ML compiled in but disabled; 404 = this build has no face
    // routes. Both mean "there is nothing to show", not "something broke".
    if (e instanceof ApiError && (e.status === 404 || e.status === 503)) {
      return {
        status: {
          enabled: false,
          provider: '',
          provider_version: 0,
          faces: 0,
          people: 0,
          unassigned: 0,
        },
        people: [],
        unassigned: [],
        unsupported: e.status === 404,
      };
    }
    throw e;
  }

  if (!status.enabled) {
    return { status, people: [], unassigned: [], unsupported: false };
  }

  const [peopleResp, facesResp] = await Promise.all([
    listPeople(libraryId),
    // The unassigned pool is optional: an older build may expose people but
    // not the standalone faces listing.
    listUnassignedFaces(libraryId).catch(() => ({ faces: [] as FaceSummary[] })),
  ]);

  return {
    status,
    people: peopleResp.people ?? [],
    unassigned: facesResp.faces ?? [],
    unsupported: false,
  };
}

interface PersonCardProps {
  libraryId: string;
  person: Person;
  expanded: boolean;
  onToggle: () => void;
  onRename: () => void;
  onMerge: () => void;
  onDelete: () => void;
  onUnassign: (faceId: string) => void;
  onSetCover: (faceId: string) => void;
}

function PersonCard({
  libraryId,
  person,
  expanded,
  onToggle,
  onRename,
  onMerge,
  onDelete,
  onUnassign,
  onSetCover,
}: PersonCardProps) {
  // A person's faces are only fetched when their card is open, so a library with
  // thousands of people does not fetch thousands of image lists. The result is
  // tagged with the person it belongs to, which keeps a re-opened card from
  // re-fetching and lets the render derive loading/error from a comparison
  // instead of a flag flipped around the request.
  const [request, setRequest] = useState<
    { key: string; faces: FaceSummary[] } | { key: string; error: string } | null
  >(null);

  const personId = person.id;
  const settled = request?.key === personId ? request : null;
  const needsFetch = expanded && settled === null;

  useEffect(() => {
    if (!needsFetch) return;
    let cancelled = false;
    getPerson(libraryId, personId)
      .then((resp) => {
        if (!cancelled) setRequest({ key: personId, faces: resp.faces ?? [] });
      })
      .catch((e: unknown) => {
        if (!cancelled) setRequest({ key: personId, error: message(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId, needsFetch, personId]);

  const faces = settled !== null && 'faces' in settled ? settled.faces : null;
  const facesError = settled !== null && 'error' in settled ? settled.error : null;

  return (
    <article className="person-card" data-testid={`person-${person.id}`}>
      <button
        type="button"
        className="person-cover"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${person.name}, ${person.face_count} faces`}
      >
        {person.cover_face_id ? (
          <img src={faceImageUrl(libraryId, person.cover_face_id)} alt="" loading="lazy" />
        ) : (
          <span className="person-cover-fallback" aria-hidden="true">
            {person.name.slice(0, 1).toUpperCase()}
          </span>
        )}
      </button>
      <div className="person-meta">
        <strong>{person.name}</strong>
        <span className="person-count">
          {person.face_count} {person.face_count === 1 ? 'face' : 'faces'}
        </span>
      </div>
      <div className="person-actions">
        <button type="button" onClick={onToggle} aria-expanded={expanded}>
          {expanded ? 'Hide' : 'Faces'}
        </button>
        <button type="button" onClick={onRename}>
          Rename
        </button>
        <button type="button" onClick={onMerge}>
          Merge
        </button>
        <button type="button" className="danger-button" onClick={onDelete}>
          Delete
        </button>
      </div>

      {expanded && (
        <div className="person-faces" data-testid={`person-faces-${person.id}`}>
          {settled === null && <span className="muted">Loading faces…</span>}
          {facesError && (
            <p className="error-text" role="alert">
              {facesError}
            </p>
          )}
          {faces !== null && faces.length === 0 && <span className="muted">No faces yet.</span>}
          {faces !== null && faces.length > 0 && (
            <div className="face-grid">
              {faces.map((face) => (
                <figure className="face-tile" key={face.id}>
                  <img src={faceImageUrl(libraryId, face.id)} alt="" loading="lazy" />
                  <figcaption>
                    <button
                      type="button"
                      onClick={() => onSetCover(face.id)}
                      disabled={person.cover_face_id === face.id}
                    >
                      {person.cover_face_id === face.id ? 'Cover' : 'Set cover'}
                    </button>
                    <button type="button" onClick={() => onUnassign(face.id)}>
                      Unassign
                    </button>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export default function PeoplePage() {
  const gate = useLibraryGate();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const selected = searchParams.get('person');

  const data = useLibraryResource<PeopleData>(loadPeople);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [renaming, setRenaming] = useState<Person | null>(null);
  const [renamingBusy, setRenamingBusy] = useState(false);
  const [renamingError, setRenamingError] = useState<string | null>(null);

  const [merging, setMerging] = useState<Person | null>(null);
  const [mergeTarget, setMergeTarget] = useState('');
  const [mergingBusy, setMergingBusy] = useState(false);
  const [mergingError, setMergingError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState<Person | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [deletingError, setDeletingError] = useState<string | null>(null);

  const [purging, setPurging] = useState(false);
  const [purgingBusy, setPurgingBusy] = useState(false);
  const [purgingError, setPurgingError] = useState<string | null>(null);

  const people = useMemo(() => data.data?.people ?? [], [data.data]);
  const libraryId = data.libraryId;

  // `?person=<id>` deep-links from the viewer's people panel and from search.
  // Following it is a state adjustment during render rather than an effect, so
  // the card is already expanded on the first paint.
  const deepLinked = selected !== null && people.some((p) => p.id === selected);
  const [prevDeepLink, setPrevDeepLink] = useState<string | null>(null);
  if (deepLinked && prevDeepLink !== selected) {
    setPrevDeepLink(selected);
    setExpanded(selected);
  } else if (!deepLinked && prevDeepLink !== null) {
    setPrevDeepLink(null);
  }

  const mergeOptions = useMemo(
    () => (merging ? people.filter((p) => p.id !== merging.id) : []),
    [merging, people],
  );

  const runPass = (kind: 'detect' | 'cluster') => {
    if (!libraryId) return;
    setBusy(kind);
    setActionError(null);
    const call = kind === 'detect' ? runFacePass : clusterFaces;
    call(libraryId)
      .then(() => {
        setNotice(
          kind === 'detect'
            ? 'Detection pass started. It runs in the background.'
            : 'Clustering started. It runs in the background.',
        );
        // The pass is asynchronous; give it a moment, then re-read.
        setTimeout(data.reload, 1200);
      })
      .catch((e: unknown) => setActionError(message(e)))
      .finally(() => setBusy(null));
  };

  const submitRename = (name: string) => {
    if (!renaming || !libraryId) return;
    setRenamingBusy(true);
    setRenamingError(null);
    renamePerson(libraryId, renaming.id, name)
      .then(() => {
        setRenaming(null);
        data.reload();
      })
      .catch((e: unknown) => setRenamingError(message(e)))
      .finally(() => setRenamingBusy(false));
  };

  const submitMerge = () => {
    if (!merging || !mergeTarget || !libraryId) return;
    setMergingBusy(true);
    setMergingError(null);
    // The URL is the survivor; the source is the person being absorbed.
    mergePeople(libraryId, mergeTarget, merging.id)
      .then(() => {
        setNotice(`Merged ${merging.name} into the person you chose.`);
        setMerging(null);
        setMergeTarget('');
        data.reload();
      })
      .catch((e: unknown) => setMergingError(message(e)))
      .finally(() => setMergingBusy(false));
  };

  const confirmDelete = () => {
    if (!deleting || !libraryId) return;
    setDeletingBusy(true);
    setDeletingError(null);
    deletePerson(libraryId, deleting.id)
      .then(() => {
        setDeleting(null);
        data.reload();
      })
      .catch((e: unknown) => setDeletingError(message(e)))
      .finally(() => setDeletingBusy(false));
  };

  const confirmPurge = () => {
    if (!libraryId) return;
    setPurgingBusy(true);
    setPurgingError(null);
    purgeFaces(libraryId)
      .then((resp) => {
        setNotice(`Removed ${resp.faces_removed} faces.`);
        setPurging(false);
        data.reload();
      })
      .catch((e: unknown) => setPurgingError(message(e)))
      .finally(() => setPurgingBusy(false));
  };

  const unassign = (personId: string, faceId: string) => {
    if (!libraryId) return;
    setActionError(null);
    unassignFace(libraryId, personId, faceId)
      .then(data.reload)
      .catch((e: unknown) => setActionError(message(e)));
  };

  const setCover = (personId: string, faceId: string) => {
    if (!libraryId) return;
    setActionError(null);
    setPersonCover(libraryId, personId, faceId)
      .then(data.reload)
      .catch((e: unknown) => setActionError(message(e)));
  };

  const assign = (faceId: string, personId: string) => {
    if (!libraryId) return;
    setActionError(null);
    assignFace(libraryId, personId, faceId)
      .then(data.reload)
      .catch((e: unknown) => setActionError(message(e)));
  };

  if (gate.kind === 'loading') {
    return (
      <main className="people-page">
        <LoadingState label="Loading libraries…" />
      </main>
    );
  }

  const header = (
    <PageHeader
      title="People"
      subtitle="Faces Cairn has detected, grouped into the people you name."
      controls={<LibraryPicker />}
    />
  );

  if (gate.kind === 'error') {
    return (
      <main className="people-page">
        {header}
        <ErrorState message={gate.message} onRetry={data.reload} />
      </main>
    );
  }

  if (gate.kind === 'empty') {
    return (
      <main className="people-page">
        {header}
        <NoLibrariesState isAdmin={user?.role === 'admin'} />
      </main>
    );
  }

  const payload = data.data;
  const status = payload?.status ?? null;
  const enabled = Boolean(status?.enabled);
  const unassigned = payload?.unassigned ?? [];

  return (
    <main className="people-page">
      {header}
      {gate.library.status === 'offline' && <LibraryOfflineNotice library={gate.library} />}

      {data.error && <ErrorState message={data.error} onRetry={data.reload} />}
      {actionError && (
        <p className="error-text" role="alert">
          {actionError}
        </p>
      )}
      {notice && (
        <p className="people-notice" role="status">
          {notice}
        </p>
      )}
      {data.loading && <LoadingState label="Loading people…" />}

      {!data.loading && payload?.unsupported && (
        <EmptyState title="Face recognition is not available" testId="faces-unsupported">
          <p className="muted">
            This server was built without face support, so it cannot detect, group, or name faces.
            Everything else about your library still works.
          </p>
        </EmptyState>
      )}

      {!data.loading && payload && !enabled && !payload.unsupported && (
        <EmptyState title="Face recognition is off" testId="faces-disabled">
          <p className="muted">
            Cairn can detect and group faces, but detection is disabled on this server. An
            administrator can turn it on with <code>CAIRN_ML_ENABLED</code> and{' '}
            <code>CAIRN_ML_FACES</code>, then run a detection pass.
          </p>
        </EmptyState>
      )}

      {enabled && status && (
        <>
          <div className="people-toolbar">
            <div className="people-actions">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => runPass('detect')}
                data-testid="detect-faces"
              >
                {busy === 'detect' ? 'Starting…' : 'Detect faces'}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => runPass('cluster')}
                data-testid="cluster-faces"
              >
                {busy === 'cluster' ? 'Starting…' : 'Cluster faces'}
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={busy !== null}
                onClick={() => setPurging(true)}
                data-testid="purge-faces"
              >
                Purge faces
              </button>
            </div>
            <span className="people-stats" data-testid="people-stats">
              {status.faces} faces · {status.people} people · {status.unassigned} unassigned
            </span>
          </div>

          {people.length === 0 ? (
            <EmptyState title="No people yet" testId="people-empty">
              <p className="muted">
                Run a detection pass to find faces, then cluster them into people. Name the groups
                and Cairn will keep recognising them.
              </p>
            </EmptyState>
          ) : (
            <section aria-label="Named people">
              <div className="people-grid" data-testid="people-grid">
                {people.map((person) => (
                  <PersonCard
                    key={person.id}
                    libraryId={gate.libraryId}
                    person={person}
                    expanded={expanded === person.id}
                    onToggle={() =>
                      setExpanded((current) => (current === person.id ? null : person.id))
                    }
                    onRename={() => {
                      setRenamingError(null);
                      setRenaming(person);
                    }}
                    onMerge={() => {
                      setMergingError(null);
                      setMergeTarget('');
                      setMerging(person);
                    }}
                    onDelete={() => {
                      setDeletingError(null);
                      setDeleting(person);
                    }}
                    onUnassign={(faceId) => unassign(person.id, faceId)}
                    onSetCover={(faceId) => setCover(person.id, faceId)}
                  />
                ))}
              </div>
            </section>
          )}

          {unassigned.length > 0 && (
            <section aria-label="Unassigned faces">
              <h2>Unassigned faces</h2>
              <p className="muted">Assign each face to a person, or leave it for clustering.</p>
              <div className="face-grid" data-testid="unassigned-faces">
                {unassigned.map((face) => (
                  <figure className="face-tile" key={face.id}>
                    <img src={faceImageUrl(gate.libraryId, face.id)} alt="" loading="lazy" />
                    <figcaption>
                      <select
                        aria-label="Assign face to person"
                        value=""
                        onChange={(event) => {
                          if (event.target.value) assign(face.id, event.target.value);
                        }}
                      >
                        <option value="">Assign to…</option>
                        {people.map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.name}
                          </option>
                        ))}
                      </select>
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <PromptDialog
        open={renaming !== null}
        title="Rename person"
        label="Name"
        initialValue={renaming?.name ?? ''}
        confirmLabel="Rename"
        busy={renamingBusy}
        error={renamingError}
        onCancel={() => setRenaming(null)}
        onConfirm={submitRename}
        testId="rename-person-dialog"
      />

      <Dialog
        open={merging !== null}
        title={`Merge ${merging?.name ?? ''} into another person`}
        onClose={() => setMerging(null)}
        testId="merge-person-dialog"
        footer={
          <>
            <button
              type="button"
              className="button"
              onClick={() => setMerging(null)}
              disabled={mergingBusy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button primary-button"
              onClick={submitMerge}
              disabled={mergingBusy || mergeTarget === ''}
            >
              {mergingBusy ? 'Merging…' : 'Merge'}
            </button>
          </>
        }
      >
        <p>
          Every face of <strong>{merging?.name}</strong> moves to the person you choose, and{' '}
          <strong>{merging?.name}</strong> is removed. This cannot be undone.
        </p>
        <label className="dialog-label" htmlFor="merge-target">
          Keep
        </label>
        <select
          id="merge-target"
          className="dialog-input"
          value={mergeTarget}
          onChange={(event) => setMergeTarget(event.target.value)}
          disabled={mergingBusy}
        >
          <option value="">Choose a person…</option>
          {mergeOptions.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
        {mergeOptions.length === 0 && (
          <p className="muted">You need at least two people to merge.</p>
        )}
        {mergingError && (
          <p className="error-text" role="alert">
            {mergingError}
          </p>
        )}
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this person?"
        destructive
        confirmLabel="Delete"
        busy={deletingBusy}
        error={deletingError}
        message={
          <p>
            <strong>{deleting?.name}</strong> will no longer be a person in this library. The
            detected faces stay on disk and can be re-assigned later.
          </p>
        }
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
        testId="delete-person-dialog"
      />

      <ConfirmDialog
        open={purging}
        title="Remove every detected face?"
        destructive
        confirmLabel="Purge"
        busy={purgingBusy}
        error={purgingError}
        message={
          <p>
            Cairn will delete all detected faces and every grouping they produced. The photos
            themselves are not touched, and the people you named become unnamed again. This cannot
            be undone.
          </p>
        }
        onCancel={() => setPurging(false)}
        onConfirm={confirmPurge}
        testId="purge-faces-dialog"
      />

      {selected && (
        <button type="button" className="visually-hidden" onClick={() => setSearchParams({})}>
          Clear person filter
        </button>
      )}
    </main>
  );
}
