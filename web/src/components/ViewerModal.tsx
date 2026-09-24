import { FormEvent, useEffect, useState } from 'react';

import { apiDelete, apiGet, apiPost, apiRequest } from '../api/client';
import type { FileSummary, Tag, TagEnvelope, TagListResponse } from '../api/types';
import { formatBytes } from '../api/types';
import { MEDIA_LABEL, downloadUrl, mediaGlyph, thumbnailUrl } from './media';
import './views.css';

export type ViewerAction = 'rename' | 'move' | 'copy' | 'delete' | 'tags';

interface ViewerModalProps {
  libraryId: string;
  file: FileSummary;
  onClose: () => void;
  onChanged: (action: ViewerAction) => Promise<void>;
}

/** Photo/video viewer with file operations and tag management. */
export function ViewerModal({ libraryId, file, onClose, onChanged }: ViewerModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [libraryTags, setLibraryTags] = useState<Tag[]>([]);
  const [fileTags, setFileTags] = useState<Tag[]>([]);
  const [tagInput, setTagInput] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Load the library's tags and the tags on this file.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      apiGet<TagListResponse>(`/libraries/${libraryId}/tags`),
      apiGet<TagListResponse>(`/libraries/${libraryId}/files/${file.id}/tags`),
    ])
      .then(([all, mine]) => {
        if (cancelled) return;
        setLibraryTags(all.tags ?? []);
        setFileTags(mine.tags ?? []);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId, file.id]);

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged('delete'); // refresh the listing (also after rename/move/copy)
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const rename = () => {
    const name = window.prompt('New file name', file.name);
    if (!name || name === file.name) return;
    void runAction(() =>
      apiPost<{ file: FileSummary }>(`/libraries/${libraryId}/files/${file.id}/rename`, {
        path: file.rel_path,
        new_name: name,
      }).then(() => undefined),
    );
  };

  const move = () => {
    const dest = window.prompt('Destination folder (relative path, e.g. archival/2024)', '');
    if (dest === null) return;
    const target = dest.replace(/^\/+|\/+$/g, '') || 'archival';
    void runAction(() =>
      apiPost<{ file: FileSummary }>(`/libraries/${libraryId}/files/${file.id}/move`, {
        path: file.rel_path,
        new_path: `${target}/${file.name}`,
      }).then(() => undefined),
    );
  };

  const copy = () => {
    const dest = window.prompt('Copy to folder (relative path)', '');
    if (dest === null) return;
    const target = dest.replace(/^\/+|\/+$/g, '') || 'copies';
    void runAction(() =>
      apiPost<{ file: FileSummary }>(`/libraries/${libraryId}/files/${file.id}/copy`, {
        path: file.rel_path,
        dest_path: `${target}/${file.name}`,
      }).then(() => undefined),
    );
  };

  const trash = () => {
    if (!window.confirm(`Move "${file.name}" to the trash?`)) return;
    void runAction(() =>
      apiRequest<undefined>(`/libraries/${libraryId}/files/${file.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ path: file.rel_path }),
      }),
    );
  };

  const refreshFileTags = async () => {
    const resp = await apiGet<TagListResponse>(`/libraries/${libraryId}/files/${file.id}/tags`);
    setFileTags(resp.tags ?? []);
  };

  const attachTag = async (raw: string) => {
    const name = raw.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const existing = libraryTags.find((t) => t.name.toLowerCase() === name.toLowerCase());
      let tagId = existing?.id;
      if (!tagId) {
        const created = await apiPost<TagEnvelope>(`/libraries/${libraryId}/tags`, { name });
        tagId = created.tag.id;
        setLibraryTags((tags) => [...tags, created.tag]);
      }
      await apiPost(`/libraries/${libraryId}/files/${file.id}/tags`, { tag_id: tagId });
      await refreshFileTags();
      setTagInput('');
      await onChanged('tags');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeTag = async (tag: Tag) => {
    setBusy(true);
    setError(null);
    try {
      await apiDelete(`/libraries/${libraryId}/files/${file.id}/tags/${tag.id}`);
      setFileTags((tags) => tags.filter((t) => t.id !== tag.id));
      await onChanged('tags');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSubmitTag = (e: FormEvent) => {
    e.preventDefault();
    void attachTag(tagInput);
  };

  const preview = file.media_type === 'photo' && (
    <img className="viewer-media" src={thumbnailUrl(libraryId, file)} alt={file.name} />
  );
  const video = file.media_type === 'video' && (
    <video className="viewer-media" src={downloadUrl(libraryId, file)} controls />
  );

  const datalistId = `tag-suggestions-${file.id}`;

  return (
    <div className="viewer-backdrop" onClick={onClose} data-testid="viewer">
      <div
        className="viewer-modal"
        role="dialog"
        aria-modal="true"
        aria-label={file.name}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="viewer-close" onClick={onClose} aria-label="Close viewer">
          ×
        </button>
        <div className="viewer-stage">
          {file.media_type === 'photo' ? (
            preview
          ) : file.media_type === 'video' ? (
            video
          ) : (
            <div className="viewer-generic">
              <span className="viewer-glyph">{mediaGlyph(file)}</span>
              <p>
                {MEDIA_LABEL[file.media_type] ?? 'File'} — preview is not available for this type.
              </p>
            </div>
          )}
        </div>
        <div className="viewer-info">
          <div className="viewer-meta">
            <h2 title={file.rel_path}>{file.name}</h2>
            <p className="muted">
              {file.folder_path || 'Library root'} · {formatBytes(file.size_bytes)} ·{' '}
              {MEDIA_LABEL[file.media_type] ?? file.media_type}
            </p>
          </div>
          <div className="viewer-actions">
            <a
              className="button"
              href={downloadUrl(libraryId, file)}
              target="_blank"
              rel="noreferrer"
            >
              Download
            </a>
            <button type="button" className="button" onClick={rename} disabled={busy}>
              Rename
            </button>
            <button type="button" className="button" onClick={move} disabled={busy}>
              Move
            </button>
            <button type="button" className="button" onClick={copy} disabled={busy}>
              Copy
            </button>
            <button type="button" className="button danger-button" onClick={trash} disabled={busy}>
              Move to trash
            </button>
          </div>
          <div className="viewer-tags" data-testid="viewer-tags">
            <h3>Tags</h3>
            {fileTags.length > 0 ? (
              <ul className="viewer-tag-list" data-testid="file-tag-list">
                {fileTags.map((t) => (
                  <li key={t.id} className="tag-chip" data-testid={`file-tag-${t.name}`}>
                    {t.name}
                    <button
                      type="button"
                      aria-label={`Remove tag ${t.name}`}
                      onClick={() => void removeTag(t)}
                      disabled={busy}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted viewer-tag-empty">No tags on this file.</p>
            )}
            <form className="viewer-tag-form" onSubmit={onSubmitTag}>
              <input
                className="viewer-tag-input"
                type="text"
                list={datalistId}
                placeholder="Add tag…"
                aria-label="Add tag"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                disabled={busy}
              />
              <datalist id={datalistId}>
                {libraryTags.map((t) => (
                  <option key={t.id} value={t.name} />
                ))}
              </datalist>
              <button type="submit" className="button" disabled={busy || tagInput.trim() === ''}>
                Add
              </button>
            </form>
          </div>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
