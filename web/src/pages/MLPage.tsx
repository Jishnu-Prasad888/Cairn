/**
 * Machine learning — similarity and faces, on one page.
 *
 * Both capabilities are optional and both are *local*: the server embeds the
 * provider, nothing is uploaded anywhere, and everything here is derived data
 * that a pass can rebuild. That shapes the whole page — a purge is offered
 * freely because it cannot lose anything, and each section explains what its
 * pass will cost before you start it.
 *
 * The ML and face routes are only registered when the server was built with the
 * corresponding dependencies, and they answer 503 when the provider is
 * disabled. A 404 or 503 therefore means "not available here", not "broken", and
 * is rendered as an explanation rather than an error.
 */

import { useState } from 'react';

import { useAuth } from '../auth/authContext';
import { ApiError } from '../api/client';
import { useLibraryGate } from '../api/libraries';
import { useLibraryResource } from '../api/resources';
import {
  clusterFaces,
  getFaceStatus,
  getMLStatus,
  purgeFaces,
  purgeSimilarity,
  runFacePass,
  runSimilarityPass,
} from '../api/queries';
import type { FaceStatus, MLStatus } from '../api/types';
import { ConfirmDialog } from '../components/Dialog';
import LibraryPicker from '../components/LibraryPicker';
import {
  ErrorState,
  LibraryOfflineNotice,
  LoadingState,
  NoLibrariesState,
  PageHeader,
} from '../components/States';
import './MLPage.css';

/** A pass is background work: the response says it started, nothing more. */
type JobState = { message: string; error: string | null } | null;

/**
 * A 404 means the build has no such route; a 503 means the provider is
 * switched off. Neither is a failure to report, so it is turned into *data*
 * here rather than thrown — the resource hook only keeps the message, so a
 * check that needs the status has to happen at the fetch boundary.
 */
type Section<T> = { available: true; status: T } | { available: false };

function asSection<T>(load: (libraryId: string) => Promise<T>) {
  return async (libraryId: string): Promise<Section<T>> => {
    try {
      return { available: true, status: await load(libraryId) };
    } catch (e: unknown) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 503)) {
        return { available: false };
      }
      throw e;
    }
  };
}

function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
}) {
  return (
    <div className="ml-stat">
      <span className="ml-stat-value">{value}</span>
      <span className="ml-stat-label">{label}</span>
      {hint && <span className="ml-stat-hint">{hint}</span>}
    </div>
  );
}

export default function MLPage() {
  const gate = useLibraryGate();
  const { user } = useAuth();

  const [busy, setBusy] = useState<string | null>(null);
  const [job, setJob] = useState<JobState>(null);
  const [purging, setPurging] = useState<'similarity' | 'faces' | null>(null);

  // The loaders are inline: `useLibraryResource` reads them through a ref, so a
  // fresh arrow on every render is free and this stays lint-clean.
  const status = useLibraryResource<Section<MLStatus>>((id) => asSection(getMLStatus)(id));
  const faces = useLibraryResource<Section<FaceStatus>>((id) => asSection(getFaceStatus)(id));

  // `null` means "still loading", which is available enough not to flash the
  // "not available" explanation before the answer arrives.
  const similarityAvailable = status.data === null || status.data.available;
  const facesAvailable = faces.data === null || faces.data.available;
  const ml = status.data?.available ? status.data.status : null;
  const face = faces.data?.available ? faces.data.status : null;

  const run = (key: string, action: (libraryId: string) => Promise<unknown>, message: string) => {
    if (gate.kind !== 'ready') return;
    setBusy(key);
    setJob({ message: 'Working…', error: null });
    action(gate.libraryId)
      .then(() => {
        setJob({ message, error: null });
        // The passes run in the background, so refresh the counters once now
        // and let the user reload when they want a fresh number.
        status.reload();
        faces.reload();
      })
      .catch((e: unknown) =>
        setJob({ message: '', error: e instanceof Error ? e.message : String(e) }),
      )
      .finally(() => setBusy(null));
  };

  if (gate.kind === 'loading') {
    return (
      <main className="ml-page">
        <LoadingState label="Loading libraries…" />
      </main>
    );
  }

  const header = (
    <PageHeader
      title="Machine learning"
      subtitle="Derived data for finding similar photos and the people in them. Everything is computed on this machine and can be discarded at any time."
      controls={<LibraryPicker />}
    />
  );

  if (gate.kind === 'error') {
    return (
      <main className="ml-page">
        {header}
        <ErrorState message={gate.message} onRetry={status.reload} />
      </main>
    );
  }

  if (gate.kind === 'empty') {
    return (
      <main className="ml-page">
        {header}
        <NoLibrariesState isAdmin={user?.role === 'admin'} />
      </main>
    );
  }

  const offline = gate.library.status === 'offline';

  return (
    <main className="ml-page">
      {header}

      {offline && <LibraryOfflineNotice library={gate.library} />}
      {job && (
        <p className={job.error ? 'error-text' : 'muted ml-job'} role="status">
          {job.error ?? job.message}
        </p>
      )}

      {/* ---------------------------- similarity --------------------------- */}
      <section className="ml-section" aria-labelledby="ml-similarity-title">
        <div className="ml-section-head">
          <h2 id="ml-similarity-title">Similar images</h2>
          {ml?.enabled && (
            <span className="status-badge status-badge-online" data-testid="ml-enabled">
              Available
            </span>
          )}
        </div>

        {!similarityAvailable ? (
          <p className="muted" data-testid="ml-unavailable">
            This Cairn server was built without local image embeddings, so visual similarity is not
            available. Everything else — including duplicate detection, which compares file bytes —
            still works.
          </p>
        ) : (
          <>
            {status.loading && <LoadingState label="Reading ML status…" />}
            {status.error && <ErrorState message={status.error} onRetry={status.reload} />}
            {ml && (
              <>
                <div className="ml-stats" data-testid="ml-stats">
                  <StatTile label="Signatures" value={String(ml.indexed ?? 0)} />
                  <StatTile label="Neighbours kept" value={String(ml.signed ?? 0)} />
                  <StatTile
                    label="Pending"
                    value={String(ml.pending ?? 0)}
                    hint={ml.pending ? 'A pass will pick these up' : undefined}
                  />
                  <StatTile
                    label="Last pass"
                    value={
                      ml.last_pass_at ? new Date(ml.last_pass_at).toLocaleDateString() : 'Never'
                    }
                    hint={ml.provider ? `Provider ${ml.provider}` : undefined}
                  />
                </div>
                {ml.error && (
                  <p className="error-text" role="alert">
                    The last pass reported: {ml.error}
                  </p>
                )}
              </>
            )}

            <div className="ml-actions">
              <button
                type="button"
                className="button primary-button"
                onClick={() =>
                  run('similarity', runSimilarityPass, 'Similarity pass started in the background.')
                }
                disabled={offline || busy !== null || ml?.enabled === false}
                data-testid="run-similarity-pass"
              >
                {busy === 'similarity' ? 'Starting…' : 'Run similarity pass'}
              </button>
              <button
                type="button"
                className="button danger-button"
                onClick={() => setPurging('similarity')}
                disabled={offline || busy !== null || ml?.enabled === false}
                data-testid="purge-similarity"
              >
                Discard signatures
              </button>
            </div>
            <p className="ml-note">
              A pass reads every image in the library and derives a small perceptual signature from
              it. It is CPU work proportional to the number of photos, and it can be stopped by
              closing the server — nothing is lost, only unfinished.
            </p>
          </>
        )}
      </section>

      {/* ------------------------------ faces ------------------------------ */}
      <section className="ml-section" aria-labelledby="ml-faces-title">
        <div className="ml-section-head">
          <h2 id="ml-faces-title">Faces and people</h2>
          {face?.enabled && (
            <span className="status-badge status-badge-online" data-testid="faces-enabled">
              Available
            </span>
          )}
        </div>

        {!facesAvailable ? (
          <p className="muted" data-testid="faces-unavailable">
            This Cairn server was built without face recognition. People, albums, and tags all still
            work — this only affects automatic face detection and clustering.
          </p>
        ) : (
          <>
            {faces.loading && <LoadingState label="Reading face status…" />}
            {faces.error && <ErrorState message={faces.error} onRetry={faces.reload} />}
            {face && (
              <div className="ml-stats" data-testid="face-stats">
                <StatTile label="Faces found" value={String(face.faces)} />
                <StatTile label="People" value={String(face.people)} />
                <StatTile
                  label="Unassigned"
                  value={String(face.unassigned)}
                  hint={face.unassigned ? 'Name these on the People page' : 'Every face has a name'}
                />
              </div>
            )}

            <div className="ml-actions">
              <button
                type="button"
                className="button primary-button"
                onClick={() => run('detect', runFacePass, 'Face detection pass started.')}
                disabled={offline || busy !== null || face?.enabled === false}
                data-testid="run-face-pass"
              >
                {busy === 'detect' ? 'Starting…' : 'Detect faces'}
              </button>
              <button
                type="button"
                className="button"
                onClick={() => run('cluster', clusterFaces, 'Face clustering pass started.')}
                disabled={offline || busy !== null || face?.enabled === false || !face?.faces}
                data-testid="run-face-cluster"
                title={face?.faces ? undefined : 'Detect faces first.'}
              >
                {busy === 'cluster' ? 'Starting…' : 'Group faces'}
              </button>
              <button
                type="button"
                className="button danger-button"
                onClick={() => setPurging('faces')}
                disabled={offline || busy !== null || face?.enabled === false}
                data-testid="purge-faces"
              >
                Discard face data
              </button>
            </div>
            <p className="ml-note">
              Detection finds the faces in each photo; grouping proposes clusters you then name on
              the People page. Names you have given are kept when either is re-run, and a purge
              removes only the derived boxes.
            </p>
          </>
        )}
      </section>

      <ConfirmDialog
        open={purging !== null}
        title={purging === 'faces' ? 'Discard all face data?' : 'Discard all signatures?'}
        destructive
        confirmLabel="Discard"
        busy={busy !== null}
        error={job?.error ?? null}
        message={
          <p>
            {purging === 'faces'
              ? 'Every detected face and its assignment to a person is removed. Names you have given are kept, and a new detection pass rebuilds the rest. Your photos are not touched.'
              : 'Every derived image signature is removed. Similar-image search stops working until a pass runs again. Your photos are not touched.'}
          </p>
        }
        onCancel={() => setPurging(null)}
        onConfirm={() => {
          const which = purging;
          if (!which) return;
          run(
            which,
            which === 'faces' ? purgeFaces : purgeSimilarity,
            which === 'faces' ? 'Face data discarded.' : 'Signatures discarded.',
          );
          setPurging(null);
        }}
        testId="ml-purge-dialog"
      />
    </main>
  );
}
