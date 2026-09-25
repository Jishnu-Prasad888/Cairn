/**
 * The media browser.
 *
 * Photos, Videos, and Files are the same view over the same API with a
 * different fixed filter, so they are one component configured three ways
 * rather than three near-identical pages. The browser owns what the brief
 * calls for here: folders, grid and list, upload, download, rename, move,
 * copy, delete, restore, trash, tags, sorting, and filtering — with cursor
 * pagination so a 100k-item library never loads in one page.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '../auth/authContext';
import { useLibraryGate } from '../api/libraries';
import { listFiles, listFolders, searchFiles, softDeleteFile, uploadFile } from '../api/queries';
import type { FileSort, FileSummary, Folder, MediaFilter, SortOrder } from '../api/queries';
import { formatBytes } from '../api/queries';
import { ConfirmDialog } from '../components/Dialog';
import { FileGrid } from '../components/FileGrid';
import { useFileOperations } from '../components/FileOperations';
import LibraryPicker from '../components/LibraryPicker';
import { downloadUrl, mediaGlyph, mediaLabel, thumbnailUrl } from '../components/media';
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

const PAGE_SIZE = 100;

export interface MediaPageConfig {
  title: string;
  /** Fixed media-type filter, or undefined to show everything. */
  type?: MediaFilter;
  /** Whether the folder tree and upload controls make sense here. */
  showFolders?: boolean;
  /** One-line explanation under the heading. */
  subtitle: string;
  emptyTitle: string;
  emptyBody: string;
}

interface FilterState {
  sort: FileSort;
  order: SortOrder;
  minSize: string;
  maxSize: string;
  from: string;
  to: string;
}

const DEFAULT_FILTERS: FilterState = {
  sort: 'mod_time',
  order: 'desc',
  minSize: '',
  maxSize: '',
  from: '',
  to: '',
};

const hasActiveFilters = (f: FilterState) =>
  f.minSize !== '' || f.maxSize !== '' || f.from !== '' || f.to !== '';

function crumbSegments(folderPath: string): Array<{ label: string; path: string }> {
  const parts = folderPath.split('/').filter(Boolean);
  const crumbs: Array<{ label: string; path: string }> = [];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

/** Multi-select actions live here; single-file actions are the viewer's. */
type PendingAction = { kind: 'trash-many'; files: FileSummary[] } | null;

export default function MediaPage({ config }: { config: MediaPageConfig }) {
  const gate = useLibraryGate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [folderPath, setFolderPath] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [search, setSearch] = useState(() => searchParams.get('q') ?? '');
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = useState(false);

  const [folders, setFolders] = useState<Folder[]>([]);
  const [files, setFiles] = useState<FileSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const [settledRun, setSettledRun] = useState<number | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<PendingAction>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const libraryId = gate.kind === 'ready' ? gate.libraryId : null;
  const library = gate.kind === 'ready' ? gate.library : null;
  const offline = gate.kind === 'ready' && gate.library.status === 'offline';

  const q = search.trim();

  // Keep the address bar in step with the search box so a result set is
  // shareable and survives a reload. Adjusted during render (React-recommended)
  // rather than in an effect.
  const urlQuery = searchParams.get('q') ?? '';
  const [prevUrlQuery, setPrevUrlQuery] = useState(urlQuery);
  if (prevUrlQuery !== urlQuery) {
    setPrevUrlQuery(urlQuery);
    setSearch(urlQuery);
  }

  // A changed folder, query, or filter invalidates the current selection —
  // also adjusted during render, for the same reason.
  const selectionKey = `${libraryId}|${folderPath}|${search}|${JSON.stringify(filters)}`;
  const [prevSelectionKey, setPrevSelectionKey] = useState(selectionKey);
  if (prevSelectionKey !== selectionKey) {
    setPrevSelectionKey(selectionKey);
    setSelected(new Set());
  }

  useEffect(() => {
    if (!libraryId) return;
    let cancelled = false;

    const params = {
      q,
      type: config.type,
      folder: q ? undefined : folderPath,
      sort: filters.sort,
      order: filters.order,
      min_size: filters.minSize ? Number(filters.minSize) : undefined,
      max_size: filters.maxSize ? Number(filters.maxSize) : undefined,
      from: filters.from ? new Date(filters.from).toISOString() : undefined,
      to: filters.to ? new Date(filters.to).toISOString() : undefined,
      limit: PAGE_SIZE,
    };

    const load = async () => {
      try {
        // Searching ignores the current folder: a query means "everywhere in
        // this library", which is what the top-bar search promises.
        const [dirs, listing] = await Promise.all([
          q || !config.showFolders || offline
            ? Promise.resolve({ folders: [] as Folder[] })
            : listFolders(libraryId, folderPath),
          q ? searchFiles(libraryId, params) : listFiles(libraryId, params),
        ]);
        if (cancelled) return;
        setFolders(dirs.folders ?? []);
        setFiles(listing.files ?? []);
        setNextCursor(listing.next_cursor);
        setTotal(listing.total ?? 0);
        setError(null);
        setSettledRun(run);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setFolders([]);
        setFiles([]);
        setNextCursor(undefined);
        setSettledRun(run);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [libraryId, folderPath, search, filters, run, offline, config.showFolders, config.type, q]);

  // Derived from the run counter so a reload shows the spinner again instead of
  // quietly leaving the previous page on screen.
  const loading = libraryId !== null && settledRun !== run;

  const reload = useCallback(() => setRun((k) => k + 1), []);

  // The viewer and its rename/move/copy/trash dialogs. The gate is not ready
  // while the libraries list is loading, in which case nothing here is used.
  const ops = useFileOperations(libraryId ?? '', reload);
  const { viewer, openViewer, closeViewer, requestAction, dialogs } = ops;

  const loadMore = async () => {
    if (!libraryId || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = {
        q,
        type: config.type,
        folder: q ? undefined : folderPath,
        sort: filters.sort,
        order: filters.order,
        min_size: filters.minSize ? Number(filters.minSize) : undefined,
        max_size: filters.maxSize ? Number(filters.maxSize) : undefined,
        from: filters.from ? new Date(filters.from).toISOString() : undefined,
        to: filters.to ? new Date(filters.to).toISOString() : undefined,
        cursor: nextCursor,
        limit: PAGE_SIZE,
      };
      const listing = q
        ? await searchFiles(libraryId, params)
        : await listFiles(libraryId, params);
      setFiles((prev) => [...prev, ...(listing.files ?? [])]);
      setNextCursor(listing.next_cursor);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleSelect = (file: FileSummary) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(file.id)) {
        next.delete(file.id);
      } else {
        next.add(file.id);
      }
      return next;
    });
  };

  // Leave selection mode with Escape, like Google Photos.
  useEffect(() => {
    if (selected.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected.size]);

  const onUpload = async (file: File | null) => {
    if (!file || !libraryId) return;
    setUploading(true);
    setUploadError(null);
    try {
      const dest = folderPath ? `${folderPath}/${file.name}` : file.name;
      await uploadFile(libraryId, file, dest);
      reload();
    } catch (e: unknown) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const runDialogAction = async (action: () => Promise<unknown>) => {
    setDialogBusy(true);
    setDialogError(null);
    try {
      await action();
      setPending(null);
      setSelected(new Set());
      reload();
    } catch (e: unknown) {
      setDialogError(e instanceof Error ? e.message : String(e));
    } finally {
      setDialogBusy(false);
    }
  };

  const closeDialog = () => {
    setPending(null);
    setDialogError(null);
  };

  const trashMany = (filesToTrash: FileSummary[]) =>
    runDialogAction(async () => {
      if (!libraryId) return;
      const results = await Promise.allSettled(
        filesToTrash.map((f) => softDeleteFile(libraryId, f.rel_path, f.id)),
      );
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length > 0) {
        throw new Error(
          `Moved ${results.length - failed.length} of ${filesToTrash.length} to the trash.`,
        );
      }
    });

  const crumbs = crumbSegments(folderPath);
  const selectedFiles = useMemo(
    () => files.filter((f) => selected.has(f.id)),
    [files, selected],
  );

  if (gate.kind === 'loading') {
    return (
      <main className="media-page">
        <LoadingState label="Loading libraries…" />
      </main>
    );
  }

  if (gate.kind === 'error') {
    return (
      <main className="media-page">
        <PageHeader title={config.title} controls={<LibraryPicker />} />
        <ErrorState message={gate.message} />
      </main>
    );
  }

  if (gate.kind === 'empty') {
    return (
      <main className="media-page">
        <PageHeader title={config.title} controls={<LibraryPicker />} />
        <NoLibraries />
      </main>
    );
  }

  return (
    <main className="media-page">
      <PageHeader
        title={config.title}
        subtitle={config.subtitle}
        controls={
          <>
            <LibraryPicker />
            {config.showFolders && !offline && (
              <label className="button upload-label">
                {uploading ? 'Uploading…' : 'Upload'}
                <input
                  type="file"
                  className="upload-input"
                  onChange={(e) => {
                    void onUpload(e.target.files?.[0] ?? null);
                    e.target.value = '';
                  }}
                  data-testid="upload-input"
                />
              </label>
            )}
          </>
        }
      />

      {library && offline && <LibraryOfflineNotice library={library} />}

      {error && <ErrorState message={error} onRetry={reload} />}
      {uploadError && (
        <p className="error-text" role="alert">
          {uploadError}
        </p>
      )}

      {selected.size > 0 ? (
        <div
          className="selection-bar"
          data-testid="selection-bar"
          role="toolbar"
          aria-label="Actions for selected media"
        >
          <span className="selection-count" data-testid="selection-count">
            {selected.size} selected
          </span>
          <div className="selection-actions">
            <a
              className="button"
              href={
                selectedFiles.length === 1 && libraryId
                  ? downloadUrl(libraryId, selectedFiles[0]!)
                  : undefined
              }
              aria-disabled={selectedFiles.length !== 1}
              onClick={(e) => {
                if (selectedFiles.length !== 1) e.preventDefault();
              }}
            >
              Download
            </a>
            <button
              type="button"
              className="button danger-button"
              onClick={() =>
                setPending({ kind: 'trash-many', files: selectedFiles })
              }
              data-testid="selection-trash"
            >
              Move to trash
            </button>
            <button type="button" className="button" onClick={() => setSelected(new Set())}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="media-toolbar">
          {config.showFolders && !q && (
            <nav className="breadcrumbs" aria-label="Folders">
              <button
                type="button"
                className="crumb"
                onClick={() => {
                  setFolderPath('');
                  setSearch('');
                }}
              >
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
                    onClick={() => {
                      setFolderPath(crumb.path);
                      setSearch('');
                    }}
                    aria-current={i === crumbs.length - 1 ? 'page' : undefined}
                  >
                    {crumb.label}
                  </button>
                </span>
              ))}
            </nav>
          )}

          <div className="media-toolbar-actions">
            <input
              className="search-input"
              type="search"
              placeholder="Search this library…"
              aria-label="Search this library"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                const next = new URLSearchParams(searchParams);
                if (e.target.value) {
                  next.set('q', e.target.value);
                } else {
                  next.delete('q');
                }
                setSearchParams(next, { replace: true });
              }}
              data-testid="media-search"
            />
            <button
              type="button"
              className={hasActiveFilters(filters) ? 'button active' : 'button'}
              onClick={() => setShowFilters((v) => !v)}
              aria-expanded={showFilters}
              aria-controls="media-filters"
              data-testid="toggle-filters"
            >
              Filters
            </button>
            <label className="sort-control">
              <span className="visually-hidden">Sort by</span>
              <select
                aria-label="Sort by"
                value={`${filters.sort}:${filters.order}`}
                onChange={(e) => {
                  const [sort, order] = e.target.value.split(':') as [FileSort, SortOrder];
                  setFilters((f) => ({ ...f, sort, order }));
                }}
                data-testid="sort-select"
              >
                <option value="mod_time:desc">Newest first</option>
                <option value="mod_time:asc">Oldest first</option>
                <option value="name:asc">Name (A–Z)</option>
                <option value="name:desc">Name (Z–A)</option>
                <option value="size:desc">Largest first</option>
                <option value="size:asc">Smallest first</option>
                <option value="media_type:asc">Type</option>
              </select>
            </label>
            <div className="view-toggle" role="group" aria-label="View">
              <button
                type="button"
                className={view === 'grid' ? 'button active' : 'button'}
                onClick={() => setView('grid')}
                aria-pressed={view === 'grid'}
              >
                Grid
              </button>
              <button
                type="button"
                className={view === 'list' ? 'button active' : 'button'}
                onClick={() => setView('list')}
                aria-pressed={view === 'list'}
              >
                List
              </button>
            </div>
          </div>
        </div>
      )}

      {showFilters && (
        <fieldset className="media-filters" id="media-filters" data-testid="media-filters">
          <legend>Filters</legend>
          <div className="media-filter-fields">
            <label>
              <span>Modified after</span>
              <input
                type="date"
                value={filters.from}
                onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
              />
            </label>
            <label>
              <span>Modified before</span>
              <input
                type="date"
                value={filters.to}
                onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
              />
            </label>
            <label>
              <span>Min size (MB)</span>
              <input
                type="number"
                min={0}
                step="any"
                value={filters.minSize}
                placeholder="0"
                onChange={(e) => setFilters((f) => ({ ...f, minSize: e.target.value }))}
              />
            </label>
            <label>
              <span>Max size (MB)</span>
              <input
                type="number"
                min={0}
                step="any"
                value={filters.maxSize}
                placeholder="Any"
                onChange={(e) => setFilters((f) => ({ ...f, maxSize: e.target.value }))}
              />
            </label>
          </div>
          {hasActiveFilters(filters) && (
            <button
              type="button"
              className="button"
              onClick={() => setFilters(DEFAULT_FILTERS)}
            >
              Clear filters
            </button>
          )}
        </fieldset>
      )}

      {loading && <LoadingState />}

      {!loading && error === null && q === '' && folders.length === 0 && files.length === 0 && (
        <EmptyState title={config.emptyTitle} testId="browser-empty">
          <p className="muted">{config.emptyBody}</p>
        </EmptyState>
      )}

      {!loading && q !== '' && files.length === 0 && (
        <EmptyState title="No matches" testId="search-empty">
          <p className="muted">
            Nothing in this library matches “{q}”
            {hasActiveFilters(filters) ? ' with the current filters' : ''}.
          </p>
        </EmptyState>
      )}

      {!loading && folders.length > 0 && (
        <ul className="folder-grid" aria-label="Folders">
          {folders.map((folder) => (
            <li key={folder.id}>
              <button
                type="button"
                className="folder-card"
                onClick={() => {
                  setFolderPath(folder.rel_path);
                  setSearch('');
                }}
              >
                <span className="folder-glyph" aria-hidden="true">
                  📁
                </span>
                <span className="folder-name">{folder.name}</span>
                <span className="folder-count">
                  {folder.file_count} {folder.file_count === 1 ? 'file' : 'files'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {!loading && files.length > 0 && (
        <>
          {view === 'list' ? (
            <FileList
              libraryId={gate.libraryId}
              files={files}
              onOpen={openViewer}
              selected={selected}
              onToggleSelect={toggleSelect}
            />
          ) : (
            <FileGrid
              libraryId={gate.libraryId}
              files={files}
              onOpen={openViewer}
              selectedIds={selected}
              onToggleSelect={toggleSelect}
            />
          )}

          <div className="media-pagination">
            <p className="muted" data-testid="result-count">
              Showing {files.length} of {total}
            </p>
            {nextCursor && (
              <button
                type="button"
                className="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                data-testid="load-more"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </div>
        </>
      )}

      {viewer && (
        <ViewerModal
          libraryId={gate.libraryId}
          file={viewer}
          siblings={files}
          onNavigate={openViewer}
          onChanged={reload}
          onRequestAction={requestAction}
          onClose={closeViewer}
        />
      )}

      {dialogs}

      <ConfirmDialog
        open={pending?.kind === 'trash-many'}
        title={`Move ${selectedFiles.length} items to trash?`}
        destructive
        confirmLabel="Move to trash"
        busy={dialogBusy}
        error={dialogError}
        message={
          <p>
            The selected items will be moved to the trash. You can restore them from the Trash page;
            your original files are not modified.
          </p>
        }
        onCancel={closeDialog}
        onConfirm={() => {
          if (pending?.kind === 'trash-many') void trashMany(pending.files);
        }}
        testId="trash-many-dialog"
      />
    </main>
  );
}

/**
 * The "you cannot see any library yet" state. Library registration is
 * admin-only, so a member is told to ask rather than offered a link to a page
 * that would 403.
 */
function NoLibraries() {
  const { user } = useAuth();
  return <NoLibrariesState isAdmin={user?.role === 'admin'} />;
}

interface FileListProps {
  libraryId: string;
  files: FileSummary[];
  onOpen: (file: FileSummary) => void;
  selected: ReadonlySet<string>;
  onToggleSelect: (file: FileSummary) => void;
}

/** The dense, information-first list view. */
function FileList({ libraryId, files, onOpen, selected, onToggleSelect }: FileListProps) {
  return (
    <table className="file-table" data-testid="file-list">
      <caption className="visually-hidden">
        Files in this folder, with size, type, and modified date
      </caption>
      <thead>
        <tr>
          <th scope="col" className="visually-hidden">
            Select
          </th>
          <th scope="col">Name</th>
          <th scope="col">Type</th>
          <th scope="col">Size</th>
          <th scope="col">Modified</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {files.map((file) => (
          <tr key={file.id} className={selected.has(file.id) ? 'file-row selected' : 'file-row'}>
            <td>
              <input
                type="checkbox"
                checked={selected.has(file.id)}
                onChange={() => onToggleSelect(file)}
                aria-label={`Select ${file.name}`}
              />
            </td>
            <th scope="row" className="file-table-name">
              <button
                type="button"
                className="file-row-main"
                onClick={() => onOpen(file)}
                title={file.rel_path}
              >
                {file.media_type === 'photo' ? (
                  <img
                    className="file-row-thumb"
                    src={thumbnailUrl(libraryId, file)}
                    alt=""
                    loading="lazy"
                  />
                ) : (
                  <span className="file-row-thumb file-row-glyph" aria-hidden="true">
                    {mediaGlyph(file)}
                  </span>
                )}
                <span className="file-row-name">{file.name}</span>
              </button>
            </th>
            <td>{mediaLabel(file.media_type)}</td>
            <td>{formatBytes(file.size_bytes)}</td>
            <td>
              <time dateTime={file.mod_time}>
                {Number.isNaN(Date.parse(file.mod_time))
                  ? file.mod_time
                  : new Date(file.mod_time).toLocaleDateString()}
              </time>
            </td>
            <td>
              <a
                className="button"
                href={downloadUrl(libraryId, file)}
                target="_blank"
                rel="noreferrer"
              >
                Download
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
