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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '../auth/authContext';
import { useLibraryGate } from '../api/libraries';
import {
  listFiles,
  copyFile,
  createFolder,
  listFolders,
  moveFile,
  searchFiles,
  softDeleteFile,
  uploadFile,
} from '../api/queries';
import type { FileSort, FileSummary, Folder, MediaFilter, SortOrder } from '../api/queries';
import { formatBytes } from '../api/queries';
import { ConfirmDialog, PromptDialog } from '../components/Dialog';
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
  /** Fixed media-type filter, or undefined to let the user choose via dropdown. */
  type?: MediaFilter;
  /** Whether the folder tree and upload controls make sense here. */
  showFolders?: boolean;
  /** One-line explanation under the heading. */
  subtitle: string;
  emptyTitle: string;
  emptyBody: string;
  /** Whether to show the type-filter dropdown (default: true when type is undefined). */
  showTypeFilter?: boolean;
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

/** Files set aside by Cut or Copy, waiting for a Paste. */
interface Clipboard {
  mode: 'cut' | 'copy';
  files: FileSummary[];
}

/** "photo.jpg" → "photo (copy).jpg", for pasting a copy next to its original. */
function copyName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (copy)${name.slice(dot)}` : `${name} (copy)`;
}

/** True when a key press is meant for a form field or an open dialog, not the page. */
function keyBelongsElsewhere(e: KeyboardEvent): boolean {
  const el = e.target;
  if (el instanceof HTMLElement) {
    if (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return true;
  }
  return document.querySelector('dialog[open], [role="dialog"]') !== null;
}

export default function MediaPage({ config }: { config: MediaPageConfig }) {
  const gate = useLibraryGate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [folderPath, setFolderPath] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [search, setSearch] = useState(() => searchParams.get('q') ?? '');
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  // When config.type is set the filter is fixed. Otherwise the user can pick.
  const showTypeFilter = config.showTypeFilter ?? config.type === undefined;
  // `?type=video` preselects the dropdown, so the Home tiles and the old
  // /photos, /videos, and /files links land on the section they name.
  const [typeFilter, setTypeFilter] = useState<MediaFilter | undefined>(() => {
    const fromUrl = searchParams.get('type');
    const known = ['photo', 'video', 'audio', 'document', 'other'];
    return (
      config.type ?? (fromUrl && known.includes(fromUrl) ? (fromUrl as MediaFilter) : undefined)
    );
  });

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
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [pasting, setPasting] = useState(false);

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
  const selectionKey = `${libraryId}|${folderPath}|${search}|${JSON.stringify(filters)}|${typeFilter ?? ''}`;
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
      type: typeFilter,
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
        const [dirs, listing] = await Promise.all([
          q || !config.showFolders || offline
            ? Promise.resolve({ folders: [] as Folder[] })
            : listFolders(libraryId, folderPath),
          q ? searchFiles(libraryId, params) : listFiles(libraryId, params),
        ]);
        if (cancelled) return;
        setFolders(dirs.folders ?? []);
        const allFiles = listing.files ?? [];
        // Client-side guard for any edge-cases where media_type is misclassified.
        const filtered = typeFilter
          ? allFiles.filter((f) => f.media_type === typeFilter)
          : allFiles;
        setFiles(filtered);
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
  }, [libraryId, folderPath, search, filters, run, offline, config.showFolders, typeFilter, q]);

  // Derived from the run counter so a reload shows the spinner again instead of
  // quietly leaving the previous page on screen.
  const loading = libraryId !== null && settledRun !== run;

  const reload = useCallback(() => setRun((k) => k + 1), []);

  // The viewer and its rename/move/copy/trash dialogs. The gate is not ready
  // while the libraries list is loading, in which case nothing here is used.
  const ops = useFileOperations(libraryId ?? '', reload);
  const { viewer, openViewer, closeViewer, requestAction, onGridAction, dialogs } = ops;

  const loadMore = async () => {
    if (!libraryId || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = {
        q,
        type: typeFilter,
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
      const listing = q ? await searchFiles(libraryId, params) : await listFiles(libraryId, params);
      const newFiles = listing.files ?? [];
      const filtered = typeFilter ? newFiles.filter((f) => f.media_type === typeFilter) : newFiles;
      setFiles((prev) => [...prev, ...filtered]);
      setNextCursor(listing.next_cursor);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  };

  // Shift-click range selection: select everything between last clicked and current.
  const lastSelectedRef = useRef<string | null>(null);

  const toggleSelect = (file: FileSummary, shiftKey = false) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastSelectedRef.current) {
        const ids = files.map((f) => f.id);
        const a = ids.indexOf(lastSelectedRef.current);
        const b = ids.indexOf(file.id);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) {
            const id = ids[i];
            if (id) next.add(id);
          }
          lastSelectedRef.current = file.id;
          return next;
        }
      }
      if (next.has(file.id)) {
        next.delete(file.id);
        lastSelectedRef.current = null;
      } else {
        next.add(file.id);
        lastSelectedRef.current = file.id;
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

  const handleDropOnFolder = async (e: React.DragEvent, destFolderPath: string) => {
    e.preventDefault();
    setDragOverFolder(null);
    const raw = e.dataTransfer.getData('application/cairn-file');
    if (!raw || !libraryId) return;
    try {
      const file = JSON.parse(raw) as { id: string; rel_path: string; name: string };
      await moveFile(libraryId, file.rel_path, file.id, destFolderPath, file.name);
      reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const crumbs = crumbSegments(folderPath);
  const selectedFiles = useMemo(() => files.filter((f) => selected.has(f.id)), [files, selected]);

  // New folders and paste target a folder, so they only make sense while
  // browsing one. Acting on files works on search results too.
  const canManage = config.showFolders && !offline && !q;
  const canActOnFiles = config.showFolders && !offline;
  const searchRef = useRef<HTMLInputElement>(null);

  const stash = (mode: Clipboard['mode']) => {
    if (selectedFiles.length === 0) return;
    setClipboard({ mode, files: selectedFiles });
    setSelected(new Set());
  };

  const paste = async () => {
    if (!libraryId || !clipboard || pasting) return;
    setPasting(true);
    setError(null);
    const results = await Promise.allSettled(
      clipboard.files.map((f) => {
        const sameFolder = f.folder_path === folderPath;
        if (clipboard.mode === 'cut') {
          // Moving a file to the folder it is already in changes nothing.
          return sameFolder
            ? Promise.resolve()
            : moveFile(libraryId, f.rel_path, f.id, folderPath, f.name);
        }
        return copyFile(
          libraryId,
          f.rel_path,
          f.id,
          folderPath,
          sameFolder ? copyName(f.name) : f.name,
        );
      }),
    );
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      const first = failed[0] as PromiseRejectedResult;
      const why = first.reason instanceof Error ? ` ${first.reason.message}` : '';
      setError(`Could not paste ${failed.length} of ${results.length} items.${why}`);
    }
    // A cut is spent once it lands; a copy can be pasted again elsewhere.
    if (clipboard.mode === 'cut') setClipboard(null);
    setPasting(false);
    reload();
  };

  // Keyboard shortcuts, in the spirit of a desktop file manager / Google Drive.
  // Keys typed into a field or an open dialog are left alone. The latest
  // listener is re-attached each render so it always sees current state.
  const onShortcut = (e: KeyboardEvent) => {
    if (keyBelongsElsewhere(e) || !libraryId || offline) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if ((mod && !e.shiftKey && key === 'k') || (!mod && !e.altKey && e.key === '/')) {
      // Jump to the search box: Ctrl+K, or "/" as in Drive and GitHub.
      const box = searchRef.current;
      if (!box) return;
      e.preventDefault();
      box.focus();
      box.select();
    } else if (mod && e.shiftKey && key === 'n') {
      if (!canManage) return;
      e.preventDefault();
      setNewFolderOpen(true);
    } else if (!mod && e.shiftKey && !e.altKey && key === 'f') {
      // Chrome reserves Ctrl+Shift+N for incognito windows, and a page cannot
      // override it; Shift+F is the same shortcut Google Drive uses.
      if (!canManage) return;
      e.preventDefault();
      setNewFolderOpen(true);
    } else if (mod && key === 'a') {
      if (files.length === 0) return;
      e.preventDefault();
      setSelected(new Set(files.map((f) => f.id)));
    } else if (mod && (key === 'c' || key === 'x')) {
      if (!canActOnFiles || selectedFiles.length === 0) return;
      e.preventDefault();
      stash(key === 'x' ? 'cut' : 'copy');
    } else if (mod && key === 'v') {
      if (!canManage || !clipboard) return;
      e.preventDefault();
      void paste();
    } else if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
      if (!canActOnFiles || selectedFiles.length === 0) return;
      e.preventDefault();
      setPending({ kind: 'trash-many', files: selectedFiles });
    } else if (!mod && e.key === 'F2') {
      if (!canActOnFiles || selectedFiles.length !== 1) return;
      e.preventDefault();
      requestAction('rename', selectedFiles[0]!);
    }
  };
  useEffect(() => {
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  });

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
            {config.showFolders && !offline && !q && (
              <button
                type="button"
                className="button"
                onClick={() => setNewFolderOpen(true)}
                title="New folder (Shift+F)"
                data-testid="new-folder-btn"
              >
                + Folder
              </button>
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

      {clipboard && canActOnFiles && (
        <div className="selection-bar" role="status" data-testid="clipboard-bar">
          <span className="selection-count">
            {clipboard.files.length} {clipboard.files.length === 1 ? 'file' : 'files'} ready to{' '}
            {clipboard.mode === 'cut' ? 'move' : 'copy'}
          </span>
          <div className="selection-actions">
            <button
              type="button"
              className="button primary-button"
              onClick={() => void paste()}
              disabled={pasting || !canManage}
              title={canManage ? 'Paste here (Ctrl+V)' : 'Open a folder to paste'}
              data-testid="clipboard-paste"
            >
              {pasting ? 'Pasting…' : 'Paste here'}
            </button>
            <button type="button" className="button" onClick={() => setClipboard(null)}>
              Clear
            </button>
          </div>
        </div>
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
            <button
              type="button"
              className="button"
              onClick={() => setSelected(new Set(files.map((f) => f.id)))}
            >
              Select all
            </button>
            {canActOnFiles && (
              <>
                <button
                  type="button"
                  className="button"
                  onClick={() => stash('cut')}
                  title="Cut (Ctrl+X)"
                  data-testid="selection-cut"
                >
                  Cut
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => stash('copy')}
                  title="Copy (Ctrl+C)"
                  data-testid="selection-copy"
                >
                  Copy
                </button>
              </>
            )}
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
              onClick={() => setPending({ kind: 'trash-many', files: selectedFiles })}
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
                className={`crumb${dragOverFolder === '' ? ' drag-over' : ''}`}
                onClick={() => {
                  setFolderPath('');
                  setSearch('');
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverFolder('');
                }}
                onDragLeave={() => setDragOverFolder(null)}
                onDrop={(e) => void handleDropOnFolder(e, '')}
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
                    className={`crumb${dragOverFolder === crumb.path ? ' drag-over' : ''}`}
                    onClick={() => {
                      setFolderPath(crumb.path);
                      setSearch('');
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverFolder(crumb.path);
                    }}
                    onDragLeave={() => setDragOverFolder(null)}
                    onDrop={(e) => void handleDropOnFolder(e, crumb.path)}
                    aria-current={i === crumbs.length - 1 ? 'page' : undefined}
                  >
                    {crumb.label}
                  </button>
                </span>
              ))}
            </nav>
          )}

          <div className="media-toolbar-actions">
            {showTypeFilter && (
              <select
                aria-label="Media type"
                className="type-filter-select"
                value={typeFilter ?? ''}
                onChange={(e) => {
                  const v = e.target.value as MediaFilter | '';
                  setTypeFilter(v === '' ? undefined : v);
                  setFolderPath('');
                }}
                data-testid="type-filter-select"
              >
                <option value="">All media</option>
                <option value="photo">Photos</option>
                <option value="video">Videos</option>
                <option value="audio">Audio</option>
                <option value="document">Documents</option>
                <option value="other">Other files</option>
              </select>
            )}
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
              ref={searchRef}
              onKeyDown={(e) => {
                // Escape empties the box (or, once empty, leaves it), so the
                // page shortcuts are usable again.
                if (e.key !== 'Escape') return;
                if (search) {
                  setSearch('');
                  const next = new URLSearchParams(searchParams);
                  next.delete('q');
                  setSearchParams(next, { replace: true });
                } else {
                  e.currentTarget.blur();
                }
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
            <button type="button" className="button" onClick={() => setFilters(DEFAULT_FILTERS)}>
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
                className={`folder-card${dragOverFolder === folder.rel_path ? ' drag-over' : ''}`}
                onClick={() => {
                  setFolderPath(folder.rel_path);
                  setSearch('');
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverFolder(folder.rel_path);
                }}
                onDragLeave={() => setDragOverFolder(null)}
                onDrop={(e) => void handleDropOnFolder(e, folder.rel_path)}
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
              onAction={onGridAction}
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
            The selected items will be moved to the trash. You can restore them from the Trash page.
          </p>
        }
        onCancel={closeDialog}
        onConfirm={() => {
          if (pending?.kind === 'trash-many') void trashMany(pending.files);
        }}
        testId="trash-many-dialog"
      />

      <PromptDialog
        open={newFolderOpen}
        title="New folder"
        label="Folder name"
        placeholder="2024/vacation"
        hint="The folder is created in the library right away."
        confirmLabel="Create"
        busy={dialogBusy}
        error={dialogError}
        onCancel={() => {
          setNewFolderOpen(false);
          setDialogError(null);
        }}
        onConfirm={(name) => {
          if (!libraryId) return;
          const clean = name.trim().replace(/^\/+|\/+$/g, '');
          if (!clean) return;
          const newPath = folderPath ? `${folderPath}/${clean}` : clean;
          setDialogBusy(true);
          setDialogError(null);
          createFolder(libraryId, newPath)
            .then(() => {
              setFolderPath(newPath);
              setNewFolderOpen(false);
            })
            .catch((e: unknown) => setDialogError(e instanceof Error ? e.message : String(e)))
            .finally(() => setDialogBusy(false));
        }}
        testId="new-folder-dialog"
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
  onToggleSelect: (file: FileSummary, shiftKey?: boolean) => void;
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
                onChange={(e) => onToggleSelect(file, (e.nativeEvent as MouseEvent).shiftKey)}
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
