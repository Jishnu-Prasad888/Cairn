/**
 * The media browser behind Photos, Videos, Files, and Search.
 *
 * They are one component configured four ways rather than four copies:
 *
 * - **Photos / Videos** are a timeline: every item of that type in the whole
 *   library, newest first, grouped by day. No folders; the photos are the page.
 * - **Files** is the file manager: folders and breadcrumbs, grid or list, an
 *   in-folder search, upload into the current folder, new folders.
 * - **Search** is a results page driven entirely by the address bar.
 *
 * What a person is looking at — the folder, the query, the type, the open
 * photo — lives in the URL, so Back, reload, and sharing a link all work.
 */

import { useCallback, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '../auth/authContext';
import { useLibraryGate } from '../api/libraries';
import { moveFile } from '../api/queries';
import type { FileSort, MediaFilter, SortOrder } from '../api/queries';
import type { FileSummary, Library } from '../api/types';
import { PromptDialog } from '../components/Dialog';
import { useFileOperations } from '../components/FileOperations';
import { Breadcrumbs } from '../components/files/Breadcrumbs';
import { FileTable } from '../components/files/FileTable';
import { FilterPanel } from '../components/files/FilterPanel';
import { EMPTY_RANGE, hasRangeFilters, type RangeFilters } from '../components/files/filters';
import { FolderGrid } from '../components/files/FolderGrid';
import type { Grouping } from '../components/media/layout';
import { MediaGrid, MediaGridSkeleton } from '../components/media/MediaGrid';
import { SelectionToolbar } from '../components/media/SelectionToolbar';
import { useFavorites } from '../components/media/useFavorites';
import { type ListingQuery, useFileListing } from '../components/media/useFileListing';
import { useMediaActions } from '../components/media/useMediaActions';
import { useSelection } from '../components/media/useSelection';
import {
  EmptyState,
  ErrorState,
  LibraryOfflineNotice,
  ListSkeleton,
  NoLibrariesState,
  PageHeader,
} from '../components/States';
import { Icon, type IconName } from '../components/ui/Icon';
import { Menu, type MenuAnchor, type MenuEntry } from '../components/ui/Menu';
import { useToast } from '../components/ui/Toast';
import { useFileDrop } from '../components/upload/useFileDrop';
import { useUploads } from '../components/upload/UploadProvider';
import { ViewerModal } from '../components/ViewerModal';
import './MediaPage.css';

export interface MediaPageConfig {
  title: string;
  /** Fixed media type. */
  type?: MediaFilter;
  /** File-manager mode: folders, breadcrumbs, list view, in-folder upload. */
  showFolders?: boolean;
  /** Offer a type dropdown. Defaults to on when no type is fixed. */
  showTypeFilter?: boolean;
  /** A results page: the query, type, person, album, and tag come from the URL. */
  searchPage?: boolean;
  /** Date headings over the grid. Only applied to date-sorted listings. */
  grouping?: Grouping;
  subtitle?: string;
  emptyTitle: string;
  emptyBody: string;
  emptyIcon?: IconName;
}

const KNOWN_TYPES: MediaFilter[] = ['photo', 'video', 'audio', 'document', 'other'];

type SortValue = `${FileSort}:${SortOrder}`;

const SORTS: Array<{ value: SortValue; label: string }> = [
  { value: 'mod_time:desc', label: 'Newest first' },
  { value: 'mod_time:asc', label: 'Oldest first' },
  { value: 'name:asc', label: 'Name (A–Z)' },
  { value: 'name:desc', label: 'Name (Z–A)' },
  { value: 'size:desc', label: 'Largest first' },
  { value: 'size:asc', label: 'Smallest first' },
  { value: 'media_type:asc', label: 'Type' },
];

const VIEW_KEY = 'cairn.files.view';

function readView(): 'grid' | 'list' {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

function parseType(value: string | null): MediaFilter | undefined {
  return value && (KNOWN_TYPES as string[]).includes(value) ? (value as MediaFilter) : undefined;
}

const numberFormat = new Intl.NumberFormat();

export default function MediaPage({ config }: { config: MediaPageConfig }) {
  const gate = useLibraryGate();
  const { user } = useAuth();

  if (gate.kind === 'loading') {
    return (
      <main className="page media-page">
        <PageHeader title={config.title} />
        <MediaGridSkeleton />
      </main>
    );
  }
  if (gate.kind === 'error') {
    return (
      <main className="page media-page">
        <PageHeader title={config.title} />
        <ErrorState message={gate.message} title="Couldn't load your libraries" />
      </main>
    );
  }
  if (gate.kind === 'empty') {
    return (
      <main className="page media-page">
        <PageHeader title={config.title} />
        <NoLibrariesState isAdmin={user?.role === 'admin'} />
      </main>
    );
  }
  return <MediaBrowser config={config} library={gate.library} />;
}

function MediaBrowser({ config, library }: { config: MediaPageConfig; library: Library }) {
  const libraryId = library.id;
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const uploads = useUploads();
  const offline = library.status === 'offline';
  const folderMode = config.showFolders ?? false;
  const showTypeFilter = config.showTypeFilter ?? config.type === undefined;

  // ---- what is being looked at, from the address bar ----
  const q = params.get('q') ?? '';
  const folder = folderMode ? (params.get('folder') ?? '') : '';
  const urlType = parseType(params.get('type'));
  const type = config.type ?? urlType;
  const person = config.searchPage ? (params.get('person') ?? undefined) : undefined;
  const album = config.searchPage ? (params.get('album') ?? undefined) : undefined;
  const tag = config.searchPage ? (params.get('tag') ?? undefined) : undefined;

  const [sortValue, setSortValue] = useState<SortValue>('mod_time:desc');
  const [sort, order] = sortValue.split(':') as [FileSort, SortOrder];
  const [range, setRange] = useState<RangeFilters>(EMPTY_RANGE);
  const [showFilters, setShowFilters] = useState(false);
  const [view, setViewState] = useState<'grid' | 'list'>(() => (folderMode ? readView() : 'grid'));
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; items: MenuEntry[] } | null>(null);

  const setView = (next: 'grid' | 'list') => {
    setViewState(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Not remembered.
    }
  };

  /** Change one URL parameter in place (typing a query should not fill history). */
  const setParam = useCallback(
    (key: string, value: string | undefined) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set(key, value);
          else next.delete(key);
          next.delete('view');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  /** Step into a folder. Each folder is a history entry, so Back steps out. */
  const openFolder = useCallback(
    (path: string) => {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        if (path) next.set('folder', path);
        else next.delete('folder');
        next.delete('q');
        next.delete('view');
        return next;
      });
    },
    [setParams],
  );

  const query: ListingQuery = {
    q,
    type,
    // A query searches the whole library; a timeline is the whole library.
    folder: folderMode && !q ? folder : undefined,
    recursive: !folderMode,
    sort,
    order,
    ...range,
    person,
    album,
    tag,
    withFolders: folderMode && !q,
  };

  const listing = useFileListing(libraryId, query, {
    enabled: !offline,
    refreshKey: uploads.completed,
  });
  const { files, folders, total } = listing;

  const favorites = useFavorites(libraryId);
  const selection = useSelection(files, `${libraryId}|${JSON.stringify(query)}`);
  const ops = useFileOperations(libraryId, listing.reload);

  const actions = useMediaActions({
    libraryId,
    selection,
    favorites,
    ops,
    onChanged: listing.reload,
    onShowInFolder: folderMode
      ? undefined
      : (file) =>
          navigate(
            file.folder_path ? `/files?folder=${encodeURIComponent(file.folder_path)}` : '/files',
          ),
  });

  const canUpload = !offline && (folderMode || config.type === 'photo' || config.type === 'video');
  const uploadFiles = useCallback(
    (incoming: File[]) => {
      if (incoming.length) uploads.enqueue(libraryId, incoming, folderMode ? folder : '');
    },
    [uploads, libraryId, folderMode, folder],
  );
  const drop = useFileDrop(uploadFiles, canUpload);

  // Dragging a tile onto a folder or a breadcrumb moves it there.
  const moveInto = async (event: React.DragEvent, destination: string) => {
    event.preventDefault();
    const raw = event.dataTransfer.getData('application/cairn-file');
    if (!raw) return;
    try {
      const dragged = JSON.parse(raw) as { id: string; rel_path: string; name: string };
      await moveFile(libraryId, dragged.rel_path, dragged.id, destination, dragged.name);
      toast({ message: `Moved to ${destination || 'All files'}`, tone: 'success' });
      listing.reload();
    } catch (e: unknown) {
      toast({ message: e instanceof Error ? e.message : "Couldn't move that file", tone: 'error' });
    }
  };

  const { menuFor } = actions;
  const openMenu = useCallback(
    (file: FileSummary, x: number, y: number) => {
      setMenu({ anchor: { x, y }, items: menuFor(file) });
    },
    [menuFor],
  );

  const grouping: Grouping =
    config.grouping && sort === 'mod_time' && !listing.searching ? config.grouping : 'none';
  const filtersActive = hasRangeFilters(range);

  let subtitle = config.subtitle;
  if (!listing.loading && !listing.error && !config.searchPage && total > 0) {
    const noun = config.type === 'photo' ? 'photo' : config.type === 'video' ? 'video' : 'item';
    subtitle = `${numberFormat.format(total)} ${total === 1 ? noun : `${noun}s`}`;
  }

  const ready = !listing.loading && !offline;
  const nothingHere = ready && !listing.error && files.length === 0 && folders.length === 0;

  return (
    <main
      className={drop.dragging ? 'page media-page is-dropping' : 'page media-page'}
      {...drop.bind}
    >
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
        title={config.title}
        subtitle={subtitle}
        controls={
          canUpload && (
            <>
              {folderMode && !q && (
                <button
                  type="button"
                  className="button"
                  onClick={() => setNewFolderOpen(true)}
                  data-testid="new-folder-btn"
                >
                  <Icon name="plus" />
                  New folder
                </button>
              )}
              <label className="button primary-button upload-button">
                <Icon name="upload" />
                Upload
                <input
                  type="file"
                  multiple
                  className="visually-hidden"
                  accept={
                    config.type === 'photo'
                      ? 'image/*'
                      : config.type === 'video'
                        ? 'video/*'
                        : undefined
                  }
                  onChange={(event) => {
                    uploadFiles(Array.from(event.target.files ?? []));
                    event.target.value = '';
                  }}
                  data-testid="upload-input"
                />
              </label>
            </>
          )
        }
      />

      {offline && <LibraryOfflineNotice library={library} />}

      {!offline && (
        <div className="media-toolbar">
          {folderMode && !q ? (
            <Breadcrumbs
              folderPath={folder}
              onNavigate={openFolder}
              onDropFile={(e, p) => void moveInto(e, p)}
            />
          ) : (
            <span className="media-toolbar-spacer" />
          )}

          <div className="media-toolbar-actions">
            {showTypeFilter && (
              <select
                aria-label="Media type"
                value={urlType ?? ''}
                onChange={(event) => setParam('type', event.target.value || undefined)}
                data-testid="type-filter-select"
              >
                <option value="">All types</option>
                <option value="photo">Photos</option>
                <option value="video">Videos</option>
                <option value="audio">Audio</option>
                <option value="document">Documents</option>
                <option value="other">Other files</option>
              </select>
            )}
            {folderMode && (
              <div className="media-search">
                <Icon name="search" size={18} />
                <input
                  type="search"
                  placeholder="Search this library"
                  aria-label="Search this library"
                  value={q}
                  onChange={(event) => setParam('q', event.target.value || undefined)}
                  data-testid="media-search"
                />
              </div>
            )}
            <button
              type="button"
              className={filtersActive ? 'button active' : 'button'}
              onClick={() => setShowFilters((v) => !v)}
              aria-expanded={showFilters}
              aria-controls="media-filters"
              data-testid="toggle-filters"
            >
              <Icon name="filter" />
              Filters
            </button>
            {!listing.searching && (
              <select
                aria-label="Sort by"
                value={sortValue}
                onChange={(event) => setSortValue(event.target.value as SortValue)}
                data-testid="sort-select"
              >
                {SORTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            )}
            {folderMode && (
              <div className="segmented" role="group" aria-label="View">
                <button
                  type="button"
                  className={view === 'grid' ? 'segmented-item active' : 'segmented-item'}
                  onClick={() => setView('grid')}
                  aria-pressed={view === 'grid'}
                  aria-label="Grid"
                  title="Grid"
                >
                  <Icon name="grid" />
                </button>
                <button
                  type="button"
                  className={view === 'list' ? 'segmented-item active' : 'segmented-item'}
                  onClick={() => setView('list')}
                  aria-pressed={view === 'list'}
                  aria-label="List"
                  title="List"
                >
                  <Icon name="list" />
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {showFilters && !offline && <FilterPanel value={range} onChange={setRange} />}

      {listing.error && (
        <ErrorState
          message={listing.error}
          onRetry={listing.reload}
          title={folderMode ? "Couldn't load this folder" : "Couldn't load your library"}
        />
      )}

      {listing.loading && (
        <div role="status" aria-label="Loading">
          {view === 'list' ? <ListSkeleton /> : <MediaGridSkeleton />}
        </div>
      )}

      {nothingHere && !listing.searching && (
        <EmptyState
          title={config.emptyTitle}
          testId="browser-empty"
          icon={config.emptyIcon ?? 'photo'}
        >
          <p>{config.emptyBody}</p>
        </EmptyState>
      )}

      {nothingHere && listing.searching && (
        <EmptyState title="No matches" testId="search-empty" icon="search">
          <p>
            {q ? <>Nothing in this library matches “{q}”</> : 'Nothing matches'}
            {filtersActive ? ' with these filters' : ''}. Try fewer words, or check the spelling.
          </p>
        </EmptyState>
      )}

      {ready && view === 'grid' && (
        <FolderGrid
          folders={folders}
          onOpen={(f) => openFolder(f.rel_path)}
          onDropFile={(e, p) => void moveInto(e, p)}
        />
      )}

      {ready && (files.length > 0 || (view === 'list' && folders.length > 0)) && (
        <>
          {view === 'list' ? (
            <FileTable
              libraryId={libraryId}
              files={files}
              folders={folders}
              onOpen={ops.openViewer}
              onOpenFolder={(f) => openFolder(f.rel_path)}
              selection={selection}
              showLocation={listing.searching}
              sort={listing.searching ? undefined : { sort, order }}
              onSort={(s, o) => setSortValue(`${s}:${o}`)}
              onMenu={openMenu}
            />
          ) : (
            files.length > 0 && (
              <MediaGrid
                libraryId={libraryId}
                files={files}
                grouping={grouping}
                onOpen={ops.openViewer}
                selection={selection}
                favorites={favorites.ids}
                onContextMenu={openMenu}
                hasMore={listing.hasMore}
                loadingMore={listing.loadingMore}
                onLoadMore={listing.loadMore}
                label={config.title}
                testId="file-grid"
              />
            )
          )}

          <footer className="media-footer">
            <p className="media-count" data-testid="result-count">
              Showing {numberFormat.format(files.length)} of{' '}
              {numberFormat.format(Math.max(total, files.length))}
            </p>
            {view === 'list' && listing.hasMore && (
              <button
                type="button"
                className="button"
                onClick={listing.loadMore}
                disabled={listing.loadingMore}
                data-testid="load-more"
              >
                {listing.loadingMore ? 'Loading more…' : 'Load more'}
              </button>
            )}
          </footer>
        </>
      )}

      {drop.dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-card">
            <Icon name="upload" size={28} />
            <span>
              Drop to upload to {folderMode && folder ? folder.split('/').pop() : library.name}
            </span>
          </div>
        </div>
      )}

      {ops.viewer && (
        <ViewerModal
          libraryId={libraryId}
          file={ops.viewer}
          siblings={files}
          onNavigate={ops.openViewer}
          onChanged={listing.reload}
          onRequestAction={ops.requestAction}
          onClose={ops.closeViewer}
          onNearEnd={listing.hasMore ? listing.loadMore : undefined}
        />
      )}

      {menu && (
        <Menu
          anchor={menu.anchor}
          items={menu.items}
          onClose={() => setMenu(null)}
          label="File actions"
        />
      )}

      {ops.dialogs}
      {actions.dialogs}

      <PromptDialog
        open={newFolderOpen}
        title="New folder"
        label="Folder name"
        placeholder="Summer 2026"
        confirmLabel="Create"
        hint="The folder appears on disk when you upload or move a file into it."
        onCancel={() => setNewFolderOpen(false)}
        onConfirm={(name) => {
          setNewFolderOpen(false);
          openFolder(folder ? `${folder}/${name}` : name);
        }}
        testId="new-folder-dialog"
      />
    </main>
  );
}
