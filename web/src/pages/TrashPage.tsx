/**
 * Trash — restore or erase for good.
 *
 * A soft-deleted file is still on disk and still indexed as `trashed`, so both
 * outcomes are reversible or not: restore puts it back where it was, and the
 * permanent delete erases the bytes. The second is the only irreversible action
 * in the product, so it is behind a dialog that says so and is not wired to the
 * same button as restore.
 */

import { useCallback, useState } from 'react';

import { useAuth } from '../auth/authContext';
import { useLibraryGate } from '../api/libraries';
import { useLibraryResource } from '../api/resources';
import { deleteForever, listTrash, restoreFile } from '../api/queries';
import type { FileSummary } from '../api/types';
import { ConfirmDialog } from '../components/Dialog';
import { useFileOperations } from '../components/FileOperations';
import LibraryPicker from '../components/LibraryPicker';
import { ViewerModal } from '../components/ViewerModal';
import {
  EmptyState,
  ErrorState,
  LibraryOfflineNotice,
  LoadingState,
  NoLibrariesState,
  PageHeader,
} from '../components/States';
import { formatBytes } from '../api/types';
import { mediaGlyph, thumbnailUrl } from '../components/media';
import './MediaPage.css';

export default function TrashPage() {
  const gate = useLibraryGate();
  const { user } = useAuth();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [erasing, setErasing] = useState<FileSummary | null>(null);

  const trash = useLibraryResource(
    useCallback(async (libraryId: string) => (await listTrash(libraryId)).files ?? [], []),
  );

  // The viewer on this page offers a permanent delete rather than a second
  // soft delete, which would be a no-op.
  const ops = useFileOperations(
    gate.kind === 'ready' ? gate.libraryId : '',
    trash.reload,
    { permanent: true },
  );

  const restore = async (file: FileSummary) => {
    if (gate.kind !== 'ready') return;
    setBusy(true);
    setError(null);
    try {
      await restoreFile(gate.libraryId, file.id);
      trash.reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (gate.kind === 'loading') {
    return (
      <main className="media-page">
        <LoadingState label="Loading libraries…" />
      </main>
    );
  }

  const header = (
    <PageHeader
      title="Trash"
      subtitle="Files you removed. Restoring puts one back exactly where it was."
      controls={<LibraryPicker />}
    />
  );

  if (gate.kind === 'error') {
    return (
      <main className="media-page">
        {header}
        <ErrorState message={gate.message} onRetry={trash.reload} />
      </main>
    );
  }

  if (gate.kind === 'empty') {
    return (
      <main className="media-page">
        {header}
        <NoLibrariesState isAdmin={user?.role === 'admin'} />
      </main>
    );
  }

  return (
    <main className="media-page">
      {header}

      {gate.library.status === 'offline' && <LibraryOfflineNotice library={gate.library} />}
      {trash.error && <ErrorState message={trash.error} onRetry={trash.reload} />}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {trash.loading && <LoadingState />}

      {trash.data !== null && trash.data.length === 0 && (
        <EmptyState title="Trash is empty" testId="trash-empty">
          <p className="muted">
            Nothing has been removed. When you move a file to the trash it waits here until you
            restore it or delete it for good.
          </p>
        </EmptyState>
      )}

      {trash.data !== null && trash.data.length > 0 && (
        <ul className="trash-list" data-testid="trash-list" aria-label="Files in the trash">
          {trash.data.map((file) => (
            <li key={file.id} className="trash-row">
              {file.media_type === 'photo' ? (
                <img
                  className="trash-thumb"
                  src={thumbnailUrl(gate.libraryId, file)}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <span className="trash-thumb trash-glyph" aria-hidden="true">
                  {mediaGlyph(file)}
                </span>
              )}
              <div className="trash-meta">
                <button
                  type="button"
                  className="trash-name"
                  onClick={() => ops.openViewer(file)}
                  title={file.rel_path}
                >
                  {file.name}
                </button>
                <span className="muted trash-sub">
                  {file.folder_path || 'Library root'} · {formatBytes(file.size_bytes)}
                </span>
              </div>
              <div className="trash-actions">
                <button
                  type="button"
                  className="button"
                  onClick={() => void restore(file)}
                  disabled={busy}
                  data-testid={`restore-${file.id}`}
                >
                  Restore
                </button>
                <button
                  type="button"
                  className="button danger-button"
                  onClick={() => setErasing(file)}
                  disabled={busy}
                  data-testid={`erase-${file.id}`}
                >
                  Delete forever
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {ops.viewer && (
        <ViewerModal
          libraryId={gate.libraryId}
          file={ops.viewer}
          siblings={trash.data ?? []}
          onNavigate={ops.openViewer}
          onChanged={trash.reload}
          onRequestAction={ops.requestAction}
          onClose={ops.closeViewer}
        />
      )}
      {ops.dialogs}

      <ConfirmDialog
        open={erasing !== null}
        title="Delete forever?"
        destructive
        confirmLabel="Delete forever"
        busy={busy}
        error={error}
        message={
          erasing && (
            <p>
              <strong>{erasing.name}</strong> will be erased from Cairn's index and its bytes removed
              from disk. <strong>This cannot be undone.</strong>
            </p>
          )
        }
        onCancel={() => setErasing(null)}
        onConfirm={() => {
          if (!erasing || gate.kind !== 'ready') return;
          const target = erasing;
          setBusy(true);
          setError(null);
          deleteForever(gate.libraryId, target.id)
            .then(() => {
              setErasing(null);
              trash.reload();
            })
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
        }}
        testId="erase-dialog"
      />
    </main>
  );
}
