/**
 * Albums — a manual grouping of files that crosses folders.
 *
 * Two screens: the album grid, and one album's contents with a searchable
 * file picker for adding to it. The picker is the reason this page exists
 * separately from Tags: an album is a curated set, a tag is a label.
 */

import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../auth/authContext';
import { useLibraryGate } from '../api/libraries';
import { useLibraryResource } from '../api/resources';
import {
  addAlbumFile,
  createAlbum,
  deleteAlbum,
  listAlbums,
  listAlbumFiles,
  listFiles,
  listFolders,
  removeAlbumFile,
  searchFiles,
} from '../api/queries';
import type { Album, FileSummary, Folder } from '../api/types';
import { ConfirmDialog, Dialog, PromptDialog } from '../components/Dialog';
import { FileGrid } from '../components/FileGrid';
import { useFileOperations } from '../components/FileOperations';
import LibraryPicker from '../components/LibraryPicker';
import { mediaGlyph, thumbnailUrl } from '../components/media';
import {
  EmptyState,
  ErrorState,
  LibraryOfflineNotice,
  LoadingState,
  NoLibrariesState,
  PageHeader,
} from '../components/States';
import { ViewerModal } from '../components/ViewerModal';
import './AlbumsPage.css';

/** Adding files to an album: browse folders or search, tick, confirm. */
function AddFilesDialog({
  libraryId,
  album,
  alreadyIn,
  onClose,
  onAdded,
}: {
  libraryId: string;
  album: Album;
  alreadyIn: string[];
  onClose: () => void;
  onAdded: () => void;
}) {
  // Tabs: 'browse' = folder tree, 'search' = free-text search
  const [tab, setTab] = useState<'browse' | 'search'>('browse');

  // ---- browse state ----
  const [folderPath, setFolderPath] = useState('');
  const [folders, setFolders] = useState<Folder[]>([]);
  const [browseFiles, setBrowseFiles] = useState<FileSummary[]>([]);
  // Loading is derived from which folder the shown listing belongs to, so the
  // effect below never has to set it synchronously.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const browseKey = `${libraryId}|${folderPath}`;
  const browseLoading = tab === 'browse' && loadedKey !== browseKey;

  // ---- search state ----
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<FileSummary[]>([]);

  // ---- shared state ----
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load folders + files for the current folder path.
  useEffect(() => {
    if (tab !== 'browse') return;
    let cancelled = false;
    void Promise.all([
      listFolders(libraryId, folderPath || undefined),
      listFiles(libraryId, { folder: folderPath, limit: 100 }),
    ])
      .then(([dirs, listing]) => {
        if (cancelled) return;
        setFolders(dirs.folders ?? []);
        setBrowseFiles(listing.files ?? []);
        setLoadedKey(browseKey);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadedKey(browseKey);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId, folderPath, tab, browseKey]);

  const runSearch = useCallback(
    async (q: string) => {
      setError(null);
      try {
        const resp = await searchFiles(libraryId, { q, limit: 50 });
        setSearchResults(resp.files ?? []);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [libraryId],
  );

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = () => {
    setBusy(true);
    setError(null);
    Promise.all([...selected].map((id) => addAlbumFile(libraryId, album.id, id)))
      .then(() => {
        onAdded();
        onClose();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const displayFiles = tab === 'browse' ? browseFiles : searchResults;

  // Build breadcrumb segments for the browse tab.
  const crumbs = folderPath
    ? folderPath.split('/').reduce<Array<{ label: string; path: string }>>((acc, part) => {
        const prev = acc[acc.length - 1]?.path ?? '';
        acc.push({ label: part, path: prev ? `${prev}/${part}` : part });
        return acc;
      }, [])
    : [];

  return (
    <Dialog
      open
      size="medium"
      title={`Add files to "${album.name}"`}
      onClose={onClose}
      dismissible={!busy}
      testId="add-files-dialog"
      footer={
        <>
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary-button"
            onClick={submit}
            disabled={busy || selected.size === 0}
            data-testid="confirm-add-files"
          >
            {busy ? 'Adding…' : `Add ${selected.size > 0 ? selected.size : ''}`.trim()}
          </button>
        </>
      }
    >
      <div className="album-picker">
        {/* Tab switcher */}
        <div className="album-picker-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'browse'}
            className={tab === 'browse' ? 'album-picker-tab active' : 'album-picker-tab'}
            onClick={() => setTab('browse')}
          >
            Browse folders
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'search'}
            className={tab === 'search' ? 'album-picker-tab active' : 'album-picker-tab'}
            onClick={() => setTab('search')}
          >
            Search
          </button>
        </div>

        {tab === 'browse' && (
          <>
            {/* Breadcrumb navigation */}
            <nav className="album-picker-breadcrumbs" aria-label="Folders">
              <button type="button" className="crumb" onClick={() => setFolderPath('')}>
                Library root
              </button>
              {crumbs.map((crumb, i) => (
                <span key={crumb.path} className="crumb-segment">
                  <span className="crumb-sep" aria-hidden="true">
                    /
                  </span>
                  <button
                    type="button"
                    className="crumb"
                    onClick={() => setFolderPath(crumb.path)}
                    aria-current={i === crumbs.length - 1 ? 'page' : undefined}
                  >
                    {crumb.label}
                  </button>
                </span>
              ))}
            </nav>

            {browseLoading && <p className="muted">Loading…</p>}

            {/* Subfolders */}
            {folders.length > 0 && (
              <ul className="album-picker-folders">
                {folders.map((folder) => (
                  <li key={folder.id}>
                    <button
                      type="button"
                      className="album-picker-folder"
                      onClick={() => setFolderPath(folder.rel_path)}
                    >
                      📁 {folder.name}
                      <span className="muted"> ({folder.file_count})</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {tab === 'search' && (
          <div className="album-picker-search-row">
            <label className="visually-hidden" htmlFor="album-picker-search">
              Search library files
            </label>
            <input
              id="album-picker-search"
              className="search-input"
              type="search"
              placeholder="Search library files…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (e.target.value.trim() === '') setSearchResults([]);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && query.trim() !== '') void runSearch(query.trim());
              }}
              data-testid="album-picker-search"
            />
            <button
              type="button"
              className="button"
              onClick={() => void runSearch(query.trim())}
              disabled={query.trim() === ''}
            >
              Search
            </button>
          </div>
        )}

        {/* Files list */}
        {displayFiles.length > 0 && (
          <ul className="picker-results">
            {displayFiles.map((f) => {
              const inAlbum = alreadyIn.includes(f.id);
              return (
                <li key={f.id} className="picker-row">
                  <label className="picker-label">
                    <input
                      type="checkbox"
                      aria-label={`Select ${f.name}`}
                      checked={selected.has(f.id)}
                      disabled={inAlbum}
                      onChange={() => toggle(f.id)}
                    />
                    {f.media_type === 'photo' ? (
                      <img className="picker-thumb" src={thumbnailUrl(libraryId, f)} alt="" />
                    ) : (
                      <span className="picker-thumb picker-glyph" aria-hidden="true">
                        {mediaGlyph(f)}
                      </span>
                    )}
                    <span className="picker-name" title={f.rel_path}>
                      {f.name}
                    </span>
                  </label>
                  {inAlbum && <span className="muted picker-note">in album</span>}
                </li>
              );
            })}
          </ul>
        )}

        {tab === 'browse' && !browseLoading && folders.length === 0 && browseFiles.length === 0 && (
          <p className="muted">This folder is empty.</p>
        )}

        {tab === 'search' && query.trim() !== '' && searchResults.length === 0 && (
          <p className="muted">No files match "{query.trim()}".</p>
        )}

        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

export default function AlbumsPage() {
  const gate = useLibraryGate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [albumId, setAlbumId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Album | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);

  const albums = useLibraryResource(
    useCallback(async (id: string) => (await listAlbums(id)).albums ?? [], []),
  );
  const files = useLibraryResource(
    useCallback((id: string) => listAlbumFiles(id, albumId!).then((r) => r.files ?? []), [albumId]),
    [albumId],
    albumId !== null,
  );

  const ops = useFileOperations(gate.kind === 'ready' ? gate.libraryId : '', () => {
    files.reload();
    albums.reload();
  });

  const run = useCallback(
    async (action: () => Promise<unknown>, after?: () => void) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        after?.();
        albums.reload();
        files.reload();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [albums, files],
  );

  if (gate.kind === 'loading') {
    return (
      <main className="albums-page">
        <LoadingState label="Loading libraries…" />
      </main>
    );
  }

  const header = (
    <PageHeader
      title="Albums"
      subtitle="Curated groups of files from anywhere in the library."
      controls={
        <>
          <LibraryPicker />
          <button
            type="button"
            className="button primary-button"
            onClick={() => {
              setPromptError(null);
              setCreating(true);
            }}
            disabled={gate.kind !== 'ready'}
            data-testid="new-album-button"
          >
            New album
          </button>
        </>
      }
    />
  );

  if (gate.kind === 'error') {
    return (
      <main className="albums-page">
        {header}
        <ErrorState message={gate.message} onRetry={albums.reload} />
      </main>
    );
  }

  if (gate.kind === 'empty') {
    return (
      <main className="albums-page">
        {header}
        <NoLibrariesState isAdmin={isAdmin} />
      </main>
    );
  }

  const library = gate.library;
  const activeAlbum = albums.data?.find((a) => a.id === albumId) ?? null;

  return (
    <main className="albums-page">
      {header}

      {library.status === 'offline' && <LibraryOfflineNotice library={library} />}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {albums.error && <ErrorState message={albums.error} onRetry={albums.reload} />}

      {activeAlbum ? (
        <section className="album-detail" data-testid="album-detail">
          <div className="album-detail-header">
            <button
              type="button"
              className="button"
              onClick={() => {
                setAlbumId(null);
                ops.closeViewer();
              }}
            >
              ← Albums
            </button>
            <h2>{activeAlbum.name}</h2>
            <div className="header-controls">
              <button
                type="button"
                className="button"
                onClick={() => setAdding(true)}
                data-testid="add-files-button"
              >
                Add files
              </button>
              <button
                type="button"
                className="button danger-button"
                onClick={() => setDeleting(activeAlbum)}
              >
                Delete album
              </button>
            </div>
          </div>

          {activeAlbum.description && <p className="muted">{activeAlbum.description}</p>}

          {files.loading && <LoadingState />}
          {files.error && <ErrorState message={files.error} onRetry={files.reload} />}

          {files.data !== null && files.data.length === 0 && (
            <EmptyState title="This album is empty" testId="album-empty">
              <p className="muted">
                Use “Add files” to bring in media from anywhere in the library.
              </p>
            </EmptyState>
          )}

          {files.data !== null && files.data.length > 0 && (
            <FileGrid
              libraryId={gate.libraryId}
              files={files.data}
              onOpen={ops.openViewer}
              renderAction={(f) => (
                <button
                  type="button"
                  className="file-card-action"
                  aria-label={`Remove ${f.name} from album`}
                  onClick={() =>
                    void run(() => removeAlbumFile(gate.libraryId, activeAlbum.id, f.id))
                  }
                >
                  ×
                </button>
              )}
            />
          )}
        </section>
      ) : (
        <>
          {albums.loading && <LoadingState />}
          {albums.data !== null && albums.data.length === 0 && (
            <EmptyState title="No albums yet" testId="albums-empty">
              <p className="muted">Create an album to group photos from any folder.</p>
            </EmptyState>
          )}
          {albums.data !== null && albums.data.length > 0 && (
            <ul className="album-grid" data-testid="albums-grid" aria-label="Albums">
              {albums.data.map((album) => (
                <li key={album.id}>
                  <button
                    type="button"
                    className="album-card"
                    onClick={() => {
                      setAlbumId(album.id);
                      ops.closeViewer();
                    }}
                  >
                    <span className="album-glyph" aria-hidden="true">
                      🗂
                    </span>
                    <span className="album-name" title={album.name}>
                      {album.name}
                    </span>
                    <span className="album-date">
                      Updated {new Date(album.updated_at).toLocaleDateString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {ops.viewer && (
        <ViewerModal
          libraryId={gate.libraryId}
          file={ops.viewer}
          siblings={files.data ?? []}
          onNavigate={ops.openViewer}
          onChanged={() => {
            files.reload();
            albums.reload();
          }}
          onRequestAction={ops.requestAction}
          onClose={ops.closeViewer}
        />
      )}
      {ops.dialogs}

      {adding && activeAlbum && (
        <AddFilesDialog
          libraryId={gate.libraryId}
          album={activeAlbum}
          alreadyIn={(files.data ?? []).map((f) => f.id)}
          onClose={() => setAdding(false)}
          onAdded={() => {
            files.reload();
            albums.reload();
          }}
        />
      )}

      <PromptDialog
        open={creating}
        title="New album"
        label="Album name"
        placeholder="Summer 2024"
        busy={busy}
        error={promptError}
        onCancel={() => setCreating(false)}
        onConfirm={(name) => {
          setBusy(true);
          setPromptError(null);
          createAlbum(gate.libraryId, name)
            .then(() => {
              setCreating(false);
              albums.reload();
            })
            .catch((e: unknown) => setPromptError(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
        }}
        testId="new-album-dialog"
      />

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete album “${deleting?.name ?? ''}”?`}
        destructive
        confirmLabel="Delete album"
        busy={busy}
        error={error}
        message={
          <p>
            The album is removed. The files in it are not affected and stay exactly where they are.
          </p>
        }
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          const target = deleting;
          void run(
            () => deleteAlbum(gate.libraryId, target.id),
            () => setAlbumId(null),
          );
        }}
        testId="delete-album-dialog"
      />
    </main>
  );
}
