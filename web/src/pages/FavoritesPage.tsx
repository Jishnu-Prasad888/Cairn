/**
 * Favorites — everything the signed-in user has starred. Per person: nobody
 * else sees your favorites. With several libraries open, the favorites of all
 * of them are merged, each tile labelled with its library.
 */

import { useCallback, useState } from 'react';

import { useLibraryGate } from '../api/libraries';
import { useOpenLibrariesResource } from '../api/resources';
import { listFavorites } from '../api/queries';
import type { Library } from '../api/types';
import { useFileOperations } from '../components/FileOperations';
import { MediaGrid, MediaGridSkeleton } from '../components/media/MediaGrid';
import { SelectionToolbar } from '../components/media/SelectionToolbar';
import { useFavorites } from '../components/media/useFavorites';
import { useMediaActions } from '../components/media/useMediaActions';
import { useSelection } from '../components/media/useSelection';
import {
  EmptyState,
  ErrorState,
  LibraryOfflineNotice,
  PageHeader,
  NoLibrariesState,
} from '../components/States';
import { useAuth } from '../auth/authContext';
import { Menu, type MenuAnchor, type MenuEntry } from '../components/ui/Menu';
import { ViewerModal } from '../components/ViewerModal';

export default function FavoritesPage() {
  const gate = useLibraryGate();
  const { user } = useAuth();

  if (gate.kind === 'loading') {
    return (
      <main className="page media-page">
        <PageHeader title="Favorites" />
        <MediaGridSkeleton />
      </main>
    );
  }
  if (gate.kind === 'error') {
    return (
      <main className="page media-page">
        <PageHeader title="Favorites" />
        <ErrorState message={gate.message} title="Couldn't load your libraries" />
      </main>
    );
  }
  if (gate.kind === 'empty') {
    return (
      <main className="page media-page">
        <PageHeader title="Favorites" />
        <NoLibrariesState isAdmin={user?.role === 'admin'} />
      </main>
    );
  }
  return (
    <Favorites
      primaryId={gate.library.id}
      library={gate.library}
      openLibraryIds={gate.openLibraryIds}
    />
  );
}

function Favorites({
  primaryId,
  library,
  openLibraryIds,
}: {
  primaryId: string;
  library: Library;
  openLibraryIds: string[];
}) {
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; items: MenuEntry[] } | null>(null);
  const favorites = useOpenLibrariesResource(
    useCallback(async (id: string) => (await listFavorites(id)).files ?? [], []),
  );
  const files = favorites.data ?? [];
  const multiOpen = openLibraryIds.length > 1;
  const offline = library.status === 'offline';

  const starred = useFavorites(openLibraryIds, files.length);
  const selection = useSelection(files, openLibraryIds.join('+'));
  const ops = useFileOperations(openLibraryIds, favorites.reload);
  const actions = useMediaActions({
    libraryId: primaryId,
    selection,
    favorites: starred,
    ops,
    onChanged: favorites.reload,
  });

  const count = favorites.data?.length ?? 0;

  return (
    <main className="page media-page">
      {selection.active && (
        <SelectionToolbar
          count={selection.size}
          total={files.length}
          actions={actions.selectionActions}
          onClear={selection.clear}
          onSelectAll={selection.selectAll}
          onDeleteKey={actions.onDeleteKey}
        />
      )}
      <PageHeader
        title="Favorites"
        subtitle={count > 0 ? `${count} ${count === 1 ? 'favorite' : 'favorites'}` : undefined}
      />

      {!multiOpen && offline && <LibraryOfflineNotice library={library} />}
      {favorites.error && (
        <ErrorState
          message={favorites.error}
          onRetry={favorites.reload}
          title="Couldn't load your favorites"
        />
      )}
      {favorites.loading && <MediaGridSkeleton />}

      {favorites.data !== null && favorites.data.length === 0 && (
        <EmptyState title="No favorites yet" testId="favorites-empty" icon="star">
          <p>Tap the star on any photo to keep it here. Only you see your favorites.</p>
        </EmptyState>
      )}

      {files.length > 0 && (
        <MediaGrid
          libraryId={primaryId}
          files={files}
          onOpen={ops.openViewer}
          selection={selection}
          favorites={starred.ids}
          onContextMenu={(file, x, y) =>
            setMenu({ anchor: { x, y }, items: actions.menuFor(file) })
          }
          label="Favorites"
          testId="file-grid"
        />
      )}

      {ops.viewer && (
        <ViewerModal
          libraryId={ops.viewerLibraryId}
          file={ops.viewer}
          siblings={files}
          onNavigate={ops.openViewer}
          onChanged={favorites.reload}
          onRequestAction={ops.requestAction}
          onClose={ops.closeViewer}
        />
      )}
      {menu && (
        <Menu
          anchor={menu.anchor}
          items={menu.items}
          onClose={() => setMenu(null)}
          label="Photo actions"
        />
      )}
      {ops.dialogs}
      {actions.dialogs}
    </main>
  );
}
