import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { apiGet, apiPost, apiUpload } from '../api/client';
import type {
  FileListResponse,
  FileSummary,
  Folder,
  FolderListResponse,
  Library,
} from '../api/types';
import { formatBytes } from '../api/types';
import { FileGrid } from '../components/FileGrid';
import { ViewerModal } from '../components/ViewerModal';
import { downloadUrl, mediaGlyph, thumbnailUrl } from '../components/media';
import './BrowserPage.css';

/** Breadcrumb segments for a relative path ("vacation/2024" -> two hops). */
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

interface FileGridProps {
  libraryId: string;
  files: FileSummary[];
  view: 'grid' | 'list';
  onOpen: (file: FileSummary) => void;
}

function FileEntries({ libraryId, files, view, onOpen }: FileGridProps) {
  if (view === 'list') {
    return (
      <ul className="file-list" data-testid="file-list">
        {files.map((f) => (
          <li key={f.id} className="file-row">
            <button type="button" className="file-row-main" onClick={() => onOpen(f)}>
              {f.media_type === 'photo' ? (
                <img
                  className="file-row-thumb"
                  src={thumbnailUrl(libraryId, f)}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <span className="file-row-thumb file-row-glyph" aria-hidden="true">
                  {mediaGlyph(f)}
                </span>
              )}
              <span className="file-row-name" title={f.rel_path}>
                {f.name}
              </span>
            </button>
            <span className="file-row-size">{formatBytes(f.size_bytes)}</span>
            <a
              className="file-row-download"
              href={downloadUrl(libraryId, f)}
              target="_blank"
              rel="noreferrer"
            >
              Download
            </a>
          </li>
        ))}
      </ul>
    );
  }

  return <FileGrid libraryId={libraryId} files={files} onOpen={onOpen} />;
}

export default function BrowserPage() {
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [search, setSearch] = useState('');
  const [folders, setFolders] = useState<Folder[]>([]);
  const [files, setFiles] = useState<FileSummary[]>([]);
  const [trash, setTrash] = useState<FileSummary[]>([]);
  const [trashOpen, setTrashOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [viewer, setViewer] = useState<FileSummary | null>(null);

  // Load the library list; default to the first one.
  useEffect(() => {
    let cancelled = false;
    apiGet<{ libraries: Library[] }>('/libraries')
      .then((resp) => {
        if (cancelled) return;
        const libs = resp.libraries ?? [];
        setLibraries(libs);
        if (libs.length > 0) setLibraryId((prev) => prev ?? libs[0]!.id);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setLibraries([]);
        setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const reload = () => setReloadKey((k) => k + 1);

  // Load the current folder (folders + files) or search results.
  useEffect(() => {
    if (!libraryId) return;
    let cancelled = false;

    const q = search.trim();
    const load = async () => {
      try {
        if (q) {
          const resp = await apiGet<{ files: FileSummary[] }>(
            `/libraries/${libraryId}/search?q=${encodeURIComponent(q)}&limit=100`,
          );
          if (cancelled) return;
          setFolders([]);
          setFiles(resp.files ?? []);
        } else {
          const folderQuery = folderPath ? `?folder=${encodeURIComponent(folderPath)}` : '';
          const parentQuery = folderPath ? `?parent=${encodeURIComponent(folderPath)}` : '';
          const [dirs, listing] = await Promise.all([
            apiGet<FolderListResponse>(`/libraries/${libraryId}/folders${parentQuery}`),
            apiGet<FileListResponse>(`/libraries/${libraryId}/files${folderQuery}`),
          ]);
          if (cancelled) return;
          setFolders(dirs.folders ?? []);
          setFiles(listing.files ?? []);
        }
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setFolders([]);
        setFiles([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [libraryId, folderPath, search, reloadKey]);

  const openTrash = async () => {
    if (!libraryId) return;
    setTrashOpen((open) => {
      if (open) return false;
      void apiGet<{ files: FileSummary[] }>(`/libraries/${libraryId}/trash`)
        .then((resp) => setTrash(resp.files ?? []))
        .catch((e: Error) => setError(e.message));
      return true;
    });
  };

  const restoreFromTrash = async (f: FileSummary) => {
    if (!libraryId) return;
    try {
      await apiPost(`/libraries/${libraryId}/files/${f.id}/restore`);
      setTrash((rows) => rows.filter((row) => row.id !== f.id));
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onUpload = async (file: File | null) => {
    if (!file || !libraryId) return;
    setUploading(true);
    setUploadError(null);
    try {
      const dest = folderPath ? `${folderPath}/${file.name}` : file.name;
      await apiUpload<{ file: FileSummary }>(`/libraries/${libraryId}/files/upload`, file, dest);
      reload();
    } catch (e: unknown) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const crumbs = crumbSegments(folderPath);

  if (libraries === null) {
    return (
      <main className="browser-page">
        <p className="muted">Loading libraries…</p>
      </main>
    );
  }

  if (libraries.length === 0) {
    return (
      <div className="page-muted">
        No libraries yet. Add a library from the server to browse files.
      </div>
    );
  }

  if (!libraryId) {
    return (
      <main className="browser-page">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  return (
    <main className="browser-page">
      <header className="page-header browser-header">
        <h1>Files</h1>
        <div className="header-controls">
          <Link to="/">Home</Link>
          <select
            aria-label="Library"
            value={libraryId ?? ''}
            onChange={(e) => {
              setLibraryId(e.target.value);
              setFolderPath('');
              setSearch('');
              setTrashOpen(false);
              setViewer(null);
            }}
          >
            {libraries.map((lib) => (
              <option key={lib.id} value={lib.id}>
                {lib.name}
              </option>
            ))}
          </select>
          <button type="button" className="button" onClick={openTrash}>
            {trashOpen ? 'Close trash' : 'Trash'}
          </button>
          <label className="button upload-label">
            {uploading ? 'Uploading…' : 'Upload'}
            <input
              type="file"
              className="upload-input"
              onChange={(e) => {
                void onUpload(e.target.files?.[0] ?? null);
                e.target.value = '';
              }}
            />
          </label>
        </div>
      </header>

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      {trashOpen && (
        <section className="trash-panel" data-testid="trash-panel">
          <h2>Trash</h2>
          {trash.length === 0 ? (
            <p className="muted">Trash is empty.</p>
          ) : (
            <ul className="file-list">
              {trash.map((f) => (
                <li key={f.id} className="file-row">
                  <span className="file-row-name" title={f.rel_path}>
                    {f.name}
                  </span>
                  <span className="file-row-size">{formatBytes(f.size_bytes)}</span>
                  <button type="button" className="button" onClick={() => void restoreFromTrash(f)}>
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!trashOpen && (
        <>
          <div className="browser-toolbar">
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

            <div className="toolbar-actions">
              <input
                className="search-input"
                type="search"
                placeholder="Search files…"
                aria-label="Search files"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="view-toggle" role="group" aria-label="View">
                <button
                  type="button"
                  className={view === 'grid' ? 'button active' : 'button'}
                  onClick={() => setView('grid')}
                >
                  Grid
                </button>
                <button
                  type="button"
                  className={view === 'list' ? 'button active' : 'button'}
                  onClick={() => setView('list')}
                >
                  List
                </button>
              </div>
            </div>
          </div>

          {uploadError && (
            <p className="error-text" role="alert">
              {uploadError}
            </p>
          )}

          {loading && <p className="muted">Loading…</p>}

          {!loading && search.trim() !== '' && files.length === 0 && (
            <div className="browser-empty" data-testid="search-empty">
              <p className="muted">No files match “{search.trim()}”.</p>
            </div>
          )}

          {!loading && search.trim() === '' && folders.length === 0 && files.length === 0 && (
            <div className="browser-empty" data-testid="browser-empty">
              <p className="muted">This folder is empty.</p>
            </div>
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
            <FileEntries libraryId={libraryId} files={files} view={view} onOpen={setViewer} />
          )}
        </>
      )}

      {viewer && libraryId && (
        <ViewerModal
          libraryId={libraryId}
          file={viewer}
          onClose={() => setViewer(null)}
          onChanged={async () => reload()}
        />
      )}
    </main>
  );
}
