import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apiDelete, apiGet, apiPut } from '../api/client';
import type { FileNote as FileNoteData } from '../api/types';
import { renderMarkdown } from '../lib/markdown';
import './views.css';

interface FileNoteProps {
  libraryId: string;
  fileId: string;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/**
 * A per-file Markdown note rendered directly under the media in the viewer.
 *
 * The note is stored server-side (the file's note endpoint) and autosaves with
 * a short debounce — the same pattern the memories editor uses. Missing notes
 * load as empty and are never an error.
 */
export function FileNote({ libraryId, fileId }: FileNoteProps) {
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // Latest draft is always available to the (debounced) autosave timer.
  const draftRef = useRef('');
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // The last body persisted on the server; the timer skips unchanged drafts.
  const lastSavedRef = useRef('');

  // Load the stored note when the file changes.
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setDraft('');
    setStatus('idle');
    setError(null);
    apiGet<{ note: FileNoteData }>(`/libraries/${libraryId}/files/${fileId}/note`)
      .then((resp) => {
        if (cancelled) return;
        lastSavedRef.current = resp.note.body;
        setDraft(resp.note.body);
        setLoaded(true);
        setMode(resp.note.body ? 'preview' : 'edit');
      })
      .catch(() => {
        // Notes are optional; a failed read behaves like an empty note.
        if (cancelled) return;
        lastSavedRef.current = '';
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId, fileId]);

  const save = useCallback(() => {
    const body = draftRef.current;
    if (body === lastSavedRef.current) return;
    setStatus('saving');
    setError(null);
    apiPut<{ note: FileNoteData }>(
      `/libraries/${libraryId}/files/${fileId}/note`,
      { body },
    )
      .then((resp) => {
        lastSavedRef.current = resp.note.body;
        setStatus('saved');
      })
      .catch((e: unknown) => {
        setStatus('error');
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [libraryId, fileId]);

  // Debounced autosave once the note has loaded and differs from the server.
  useEffect(() => {
    if (!loaded) return;
    if (draftRef.current === lastSavedRef.current) return;
    const timer = setTimeout(save, 800);
    return () => clearTimeout(timer);
  }, [draft, loaded, save]);

  const clear = async () => {
    setDraft('');
    setError(null);
    try {
      await apiDelete(`/libraries/${libraryId}/files/${fileId}/note`);
      lastSavedRef.current = '';
      setStatus('saved');
    } catch (e: unknown) {
      setStatus('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const preview = useMemo(() => (draft ? renderMarkdown(draft).html : ''), [draft]);
  const hasNote = draft.trim() !== '';

  return (
    <section className="viewer-note" data-testid="viewer-note">
      <div className="viewer-note-header">
        <h3>Note</h3>
        <div className="viewer-note-controls">
          <div className="viewer-note-tabs" role="group" aria-label="Note view">
            <button
              type="button"
              className={mode === 'edit' ? 'viewer-note-tab active' : 'viewer-note-tab'}
              onClick={() => setMode('edit')}
              aria-pressed={mode === 'edit'}
            >
              Write
            </button>
            <button
              type="button"
              className={mode === 'preview' ? 'viewer-note-tab active' : 'viewer-note-tab'}
              onClick={() => setMode('preview')}
              aria-pressed={mode === 'preview'}
            >
              Preview
            </button>
          </div>
          {hasNote && (
            <button type="button" className="viewer-note-clear" onClick={() => void clear()}>
              Clear
            </button>
          )}
          <span className={`note-status note-status-${status}`} role="status" aria-live="polite">
            {status === 'saving' && 'Saving…'}
            {status === 'saved' && 'Saved'}
            {status === 'error' && 'Save failed'}
            {status === 'idle' && ''}
          </span>
        </div>
      </div>

      {mode === 'edit' ? (
        <textarea
          className="viewer-note-input"
          aria-label="Markdown note"
          placeholder={'Add a Markdown note…\n\n_This text will be shown under the image._'}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setStatus('idle');
          }}
          rows={4}
        />
      ) : hasNote ? (
        <div
          className="viewer-note-preview"
          aria-label="Markdown note preview"
          dangerouslySetInnerHTML={{ __html: preview }}
        />
      ) : (
        <p className="muted viewer-note-empty">No note yet — use Write to add one.</p>
      )}

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}