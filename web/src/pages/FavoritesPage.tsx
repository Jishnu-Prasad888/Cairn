/**
 * Favorites — everything the signed-in user has starred.
 *
 * Favorites are per-user, not per-album, so this is a flat view over one
 * library with the same viewer, tags, and file operations as anywhere else.
 */

import { useLibraryGate } from '../api/libraries';
import { useLibraryResource } from '../api/resources';
import { listFavorites } from '../api/queries';
import { useAuth } from '../auth/authContext';
import { FileGrid } from '../components/FileGrid';
import { useFileOperations } from '../components/FileOperations';
import LibraryPicker from '../components/LibraryPicker';
import {
  EmptyState,
  ErrorState,
  LibraryOfflineNotice,
  LoadingState,
  NoLibrariesState,
  PageHeader,
} from '../components/States';
import { ViewerModal } from '../components/ViewerModal';
import './MediaPage.css';

export default function FavoritesPage() {
  const gate = useLibraryGate();
  const { user } = useAuth();

  const favorites = useLibraryResource(async (libraryId: string) => {
    return (await listFavorites(libraryId)).files ?? [];
  });

  const ops = useFileOperations(gate.kind === 'ready' ? gate.libraryId : '', favorites.reload);

  if (gate.kind === 'loading') {
    return (
      <main className="media-page">
        <LoadingState label="Loading libraries…" />
      </main>
    );
  }

  const header = (
    <PageHeader
      title="Favorites"
      subtitle="The files you have starred. Only you see your favorites."
      controls={<LibraryPicker />}
    />
  );

  if (gate.kind === 'error') {
    return (
      <main className="media-page">
        {header}
        <ErrorState message={gate.message} onRetry={favorites.reload} />
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
      {favorites.error && <ErrorState message={favorites.error} onRetry={favorites.reload} />}
      {favorites.loading && <LoadingState />}

      {favorites.data !== null && favorites.data.length === 0 && (
        <EmptyState title="No favorites yet" testId="favorites-empty">
          <p className="muted">
            Open any file and press the star to keep it here. Favorites are yours alone — nobody
            else sees them.
          </p>
        </EmptyState>
      )}

      {favorites.data !== null && favorites.data.length > 0 && (
        <>
          <FileGrid
            libraryId={gate.libraryId}
            files={favorites.data}
            onOpen={ops.openViewer}
          />
          <p className="muted media-pagination">
            {favorites.data.length}{' '}
            {favorites.data.length === 1 ? 'favorite' : 'favorites'}
          </p>
        </>
      )}

      {ops.viewer && (
        <ViewerModal
          libraryId={gate.libraryId}
          file={ops.viewer}
          siblings={favorites.data ?? []}
          onNavigate={ops.openViewer}
          onChanged={favorites.reload}
          onRequestAction={ops.requestAction}
          onClose={ops.closeViewer}
        />
      )}
      {ops.dialogs}
    </main>
  );
}
