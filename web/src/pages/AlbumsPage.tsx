import { useEffect, useState } from 'react';

import { apiDelete, apiGet, apiPost } from '../api/client';
import type {
  Album,
  AlbumListResponse,
  FileCollectionResponse,
  FileSummary,
  Library,
} from '../api/types';
import { FileGrid } from '../components/FileGrid';
import { ViewerModal } from '../components/ViewerModal';
import { thumbnailUrl } from '../components/media';
import './AlbumsPage.css';

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export default function AlbumsPage() {
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [albumId, setAlbumId] = useState<string | null>(null);
  const [albumFiles, setAlbumFiles] = useState<FileSummary[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerResults, setPickerResults] = useState<FileSummary[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [viewer, setViewer] = useState<FileSummary | null>(null);

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

  useEffect(() => {
    if (!libraryId) return;
    let cancelled = false;
    void apiGet<AlbumListResponse>(`/libraries/${libraryId}/albums`)
      .then((resp) => {
        if (!cancelled) setAlbums(resp.albums ?? []);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setAlbums([]);
        setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId, reloadKey]);

  useEffect(() => {
    if (!libraryId || !albumId) return;
    let cancelled = false;
    void apiGet<FileCollectionResponse>(`/libraries/${libraryId}/albums/${albumId}/files`)
      .then((resp) => {
        if (!cancelled) setAlbumFiles(resp.files ?? []);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setAlbumFiles([]);
        setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId, albumId, reloadKey]);

  // Picker search: live results by file name.
  useEffect(() => {
    if (!libraryId || !pickerOpen || pickerQuery.trim() === '') return;
    let cancelled = false;
    const q = pickerQuery.trim();
    void apiGet<{ files: FileSummary[] }>(
      `/libraries/${libraryId}/search?q=${encodeURIComponent(q)}&limit=50`,
    )
      .then((resp) => {
        if (!cancelled) setPickerResults(resp.files ?? []);
      })
      .catch((e: Error) => {
        if (!cancelled) setPickerError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId, pickerOpen, pickerQuery]);

  const createAlbum = async () => {
    if (!libraryId) return;
    const name = window.prompt('Album name');
    if (!name || !name.trim()) return;
    try {
      await apiPost(`/libraries/${libraryId}/albums`, { name: name.trim() });
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteAlbum = async () => {
    if (!libraryId || !albumId) return;
    const album = albums?.find((a) => a.id === albumId);
    if (!window.confirm(`Delete album "${album?.name ?? ''}"? Files are not affected.`)) return;
    try {
      await apiDelete(`/libraries/${libraryId}/albums/${albumId}`);
      setAlbumId(null);
      setAlbumFiles(null);
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeFromAlbum = async (file: FileSummary) => {
    if (!libraryId || !albumId) return;
    try {
      await apiDelete(`/libraries/${libraryId}/albums/${albumId}/files/${file.id}`);
      setAlbumFiles((rows) => (rows ? rows.filter((f) => f.id !== file.id) : rows));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addSelected = async () => {
    if (!libraryId || !albumId || selected.size === 0) return;
    setPickerError(null);
    try {
      await Promise.all(
        [...selected].map((id) => apiPost(`/libraries/${libraryId}/albums/${albumId}/files/${id}`)),
      );
      setSelected(new Set());
      setPickerOpen(false);
      setPickerQuery('');
      reload();
    } catch (e: unknown) {
      setPickerError(e instanceof Error ? e.message : String(e));
    }
  };

  if (libraries === null) {
    return (
      <main className="albums-page">
        <p className="muted">Loading libraries…</p>
      </main>
    );
  }

  if (libraries.length === 0) {
    return (
      <div className="page-muted">
        No libraries yet. Add a library from the server to organize media.
      </div>
    );
  }

  if (!libraryId) {
    return (
      <main className="albums-page">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const activeAlbum = albums?.find((a) => a.id === albumId);

  return (
    <main className="albums-page">
      <header className="page-header albums-header">
        <h1>Albums</h1>
        <div className="header-controls">
          <select
            aria-label="Library"
            value={libraryId}
            onChange={(e) => {
              setLibraryId(e.target.value);
              setAlbums(null);
              setAlbumId(null);
              setAlbumFiles(null);
              setPickerOpen(false);
              setViewer(null);
              setError(null);
            }}
          >
            {libraries.map((lib) => (
              <option key={lib.id} value={lib.id}>
                {lib.name}
              </option>
            ))}
          </select>
          <button type="button" className="button" onClick={() => void createAlbum()}>
            New album
          </button>
        </div>
      </header>

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      {albumId ? (
        <section className="album-detail" data-testid="album-detail">
          <div className="album-detail-header">
            <button type="button" className="button" onClick={() => setAlbumId(null)}>
              ← Albums
            </button>
            <h2>{activeAlbum?.name ?? 'Album'}</h2>
            <div className="header-controls">
              <button
                type="button"
                className="button"
                onClick={() => {
                  setPickerOpen((v) => {
                    if (v) {
                      setSelected(new Set());
                      setPickerResults([]);
                    }
                    return !v;
                  });
                }}
              >
                {pickerOpen ? 'Close picker' : 'Add files'}
              </button>
              <button
                type="button"
                className="button danger-button"
                onClick={() => void deleteAlbum()}
              >
                Delete album
              </button>
            </div>
          </div>

          {pickerOpen && (
            <section className="album-picker" data-testid="album-picker">
              <input
                className="search-input"
                type="search"
                placeholder="Search library files…"
                aria-label="Search files to add"
                value={pickerQuery}
                onChange={(e) => {
                  setPickerQuery(e.target.value);
                  if (e.target.value.trim() === '') setPickerResults([]);
                }}
              />
              {pickerResults.length > 0 && (
                <ul className="picker-results">
                  {pickerResults.map((f) => {
                    const inAlbum = albumFiles?.some((row) => row.id === f.id) ?? false;
                    return (
                      <li key={f.id} className="picker-row">
                        <label className="picker-label">
                          <input
                            type="checkbox"
                            aria-label={`Select ${f.name}`}
                            checked={selected.has(f.id)}
                            disabled={inAlbum}
                            onChange={() => toggleSelected(f.id)}
                          />
                          {f.media_type === 'photo' ? (
                            <img className="picker-thumb" src={thumbnailUrl(libraryId, f)} alt="" />
                          ) : (
                            <span className="picker-thumb picker-glyph" aria-hidden="true">
                              {f.name.slice(0, 1).toUpperCase()}
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
              {pickerQuery.trim() !== '' && pickerResults.length === 0 && (
                <p className="muted">No files match “{pickerQuery.trim()}”.</p>
              )}
              <button
                type="button"
                className="button"
                onClick={() => void addSelected()}
                disabled={selected.size === 0}
              >
                Add selected ({selected.size})
              </button>
              {pickerError && (
                <p className="error-text" role="alert">
                  {pickerError}
                </p>
              )}
            </section>
          )}

          {albumFiles === null && <p className="muted">Loading…</p>}

          {albumFiles !== null && albumFiles.length === 0 && (
            <div className="album-empty" data-testid="album-empty">
              <p className="muted">This album is empty. Use “Add files” to bring in media.</p>
            </div>
          )}

          {albumFiles !== null && albumFiles.length > 0 && (
            <FileGrid
              libraryId={libraryId}
              files={albumFiles}
              onOpen={setViewer}
              renderAction={(f) => (
                <button
                  type="button"
                  className="file-card-action"
                  aria-label={`Remove ${f.name} from album`}
                  onClick={() => void removeFromAlbum(f)}
                >
                  ×
                </button>
              )}
            />
          )}
        </section>
      ) : (
        <>
          {albums === null && <p className="muted">Loading…</p>}
          {albums !== null && albums.length === 0 && (
            <div className="album-empty" data-testid="albums-empty">
              <p className="muted">No albums yet. Create one to group your media.</p>
            </div>
          )}
          {albums !== null && albums.length > 0 && (
            <ul className="album-grid" data-testid="albums-grid" aria-label="Albums">
              {albums.map((album) => (
                <li key={album.id}>
                  <button
                    type="button"
                    className="album-card"
                    onClick={() => {
                      setAlbumId(album.id);
                      setAlbumFiles(null);
                      setPickerOpen(false);
                      setSelected(new Set());
                      setPickerResults([]);
                    }}
                  >
                    <span className="album-glyph" aria-hidden="true">
                      🗂
                    </span>
                    <span className="album-name" title={album.name}>
                      {album.name}
                    </span>
                    <span className="album-date">Updated {formatDate(album.updated_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {viewer && (
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
