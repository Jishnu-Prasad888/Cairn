import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { apiDelete, apiGet, apiPost } from '../api/client';
import type { FileSummary, Library, Tag, TagListResponse } from '../api/types';
import { FileGrid } from '../components/FileGrid';
import { ViewerModal } from '../components/ViewerModal';
import './TagsPage.css';

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export default function TagsPage() {
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [activeTag, setActiveTag] = useState<Tag | null>(null);
  const [tagFiles, setTagFiles] = useState<FileSummary[] | null>(null);
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
    void apiGet<TagListResponse>(`/libraries/${libraryId}/tags`)
      .then((resp) => {
        if (!cancelled) setTags(resp.tags ?? []);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setTags([]);
        setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId, reloadKey]);

  useEffect(() => {
    if (!libraryId || !activeTag) return;
    let cancelled = false;
    void apiGet<{ files: FileSummary[] }>(
      `/libraries/${libraryId}/search?tag=${encodeURIComponent(activeTag.name)}&limit=200`,
    )
      .then((resp) => {
        if (!cancelled) setTagFiles(resp.files ?? []);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setTagFiles([]);
        setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId, activeTag, reloadKey]);

  const createTag = async () => {
    if (!libraryId) return;
    const name = window.prompt('Tag name');
    if (!name || !name.trim()) return;
    try {
      await apiPost(`/libraries/${libraryId}/tags`, { name: name.trim() });
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeTagFromFile = async (file: FileSummary) => {
    if (!libraryId || !activeTag) return;
    try {
      await apiDelete(`/libraries/${libraryId}/files/${file.id}/tags/${activeTag.id}`);
      setTagFiles((rows) => (rows ? rows.filter((f) => f.id !== file.id) : rows));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteTag = async () => {
    if (!libraryId || !activeTag) return;
    if (!window.confirm(`Delete tag "${activeTag.name}"? It is removed from every file.`)) return;
    try {
      await apiDelete(`/libraries/${libraryId}/tags/${activeTag.id}`);
      setActiveTag(null);
      setTagFiles(null);
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (libraries === null) {
    return (
      <main className="tags-page">
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
      <main className="tags-page">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  return (
    <main className="tags-page">
      <header className="page-header tags-header">
        <h1>Tags</h1>
        <div className="header-controls">
          <Link to="/">Home</Link>
          <select
            aria-label="Library"
            value={libraryId}
            onChange={(e) => {
              setLibraryId(e.target.value);
              setTags(null);
              setActiveTag(null);
              setTagFiles(null);
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
          <button type="button" className="button" onClick={() => void createTag()}>
            New tag
          </button>
        </div>
      </header>

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      {activeTag ? (
        <section className="tag-detail" data-testid="tag-detail">
          <div className="tag-detail-header">
            <button type="button" className="button" onClick={() => setActiveTag(null)}>
              ← Tags
            </button>
            <h2>
              <span className="tag-chip">{activeTag.name}</span>
            </h2>
            <button type="button" className="button danger-button" onClick={() => void deleteTag()}>
              Delete tag
            </button>
          </div>

          {tagFiles === null && <p className="muted">Loading…</p>}

          {tagFiles !== null && tagFiles.length === 0 && (
            <div className="tag-empty" data-testid="tag-files-empty">
              <p className="muted">No files carry this tag yet.</p>
            </div>
          )}

          {tagFiles !== null && tagFiles.length > 0 && (
            <FileGrid
              libraryId={libraryId}
              files={tagFiles}
              onOpen={setViewer}
              renderAction={(f) => (
                <button
                  type="button"
                  className="file-card-action"
                  aria-label={`Remove tag ${activeTag.name} from ${f.name}`}
                  onClick={() => void removeTagFromFile(f)}
                >
                  ×
                </button>
              )}
            />
          )}
        </section>
      ) : (
        <>
          {tags === null && <p className="muted">Loading…</p>}
          {tags !== null && tags.length === 0 && (
            <div className="tag-empty" data-testid="tags-empty">
              <p className="muted">No tags yet. Tag media from the file browser to organize it.</p>
            </div>
          )}
          {tags !== null && tags.length > 0 && (
            <ul className="tag-grid" data-testid="tags-grid" aria-label="Tags">
              {tags.map((tag) => (
                <li key={tag.id}>
                  <button type="button" className="tag-card" onClick={() => setActiveTag(tag)}>
                    <span className="tag-chip">{tag.name}</span>
                    <span className="tag-date">Created {formatDate(tag.created_at)}</span>
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
