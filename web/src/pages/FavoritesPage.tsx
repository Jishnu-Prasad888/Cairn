/**
 * Favorites — everything the signed-in user has starred. Per person: nobody
 * else sees your favorites. With several libraries open, the favorites of all
 * of them are merged, each tile labelled with its library.
 */

import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useLibraryGate } from '../api/libraries';
import { useOpenLibrariesResource } from '../api/resources';
import { listFavoriteFolders, listFavorites } from '../api/queries';
import { folderKey } from '../api/resourceKeys';
import type { Folder, Library } from '../api/types';
import { FolderGrid } from '../components/files/FolderGrid';
import { useFolderActions } from '../components/files/useFolderActions';
import { ShareDialog } from '../components/sharing/ShareDialog';
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
  const navigate = useNavigate();

  // Starred folders sit above the starred files, as on the Files page.
  const starredFolders = useOpenLibrariesResource(
    useCallback(
      async (id: string) =>
        ((await listFavoriteFolders(id)).folders ?? []).map((f) => ({ ...f, library_id: id })),
      [],
    ),
  );
  const folders = starredFolders.data ?? [];
  const [shareFolder, setShareFolder] = useState<Folder | null>(null);
  const openFolder = (f: Folder) => {
    const lib = multiOpen && f.library_id ? `&lib=${encodeURIComponent(f.library_id)}` : '';
    navigate(`/files?folder=${encodeURIComponent(f.rel_path)}${lib}`);
  };
  const folderActions = useFolderActions({
    libraryIds: openLibraryIds,
    fallbackLibraryId: primaryId,
    onOpen: openFolder,
    onChanged: starredFolders.reload,
    onShare: setShareFolder,
    canManage: !offline,
  });

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

  const count = (favorites.data?.length ?? 0) + folders.length;

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

      {favorites.data !== null && favorites.data.length === 0 && folders.length === 0 && (
        <EmptyState title="No favorites yet" testId="favorites-empty" icon="star">
          <p>
            Tap the star on any photo, or right-click a folder and add it to favourites, to keep it
            here. Only you see your favorites.
          </p>
        </EmptyState>
      )}

      {folders.length > 0 && (
        <section aria-label="Favourite folders">
          <FolderGrid
            folders={folders}
            onOpen={openFolder}
            onMenu={(f, x, y) => setMenu({ anchor: { x, y }, items: folderActions.menuFor(f) })}
            isFavorite={folderActions.isFavorite}
          />
        </section>
      )}

      {files.length > 0 && (
        <MediaGrid
          libraryId={primaryId}
          files={files}
          onOpen={ops.openViewer}
          selection={selection}
          favorites={starred.ids}
          onDelete={actions.onDeleteFile}
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
      {folderActions.dialogs}
      {shareFolder && (
        <ShareDialog
          libraryId={shareFolder.library_id || primaryId}
          resourceKey={folderKey(shareFolder.library_id || primaryId, shareFolder.rel_path)}
          title={`Share "${shareFolder.name}"`}
          resourceLabel="folder"
          testIdPrefix="folder"
          viewCaps={['read', 'download']}
          editCaps={['read', 'download', 'edit']}
          onClose={() => setShareFolder(null)}
        />
      )}
    </main>
  );
}
