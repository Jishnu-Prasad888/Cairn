import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apiDelete, apiGet, apiPost, apiPut } from '../api/client';
import type { Library, Memory, MemoryVersion, RefType } from '../api/types';
import { insertRefAtCursor } from '../lib/editor';
import { extractRefs, renderMarkdown } from '../lib/markdown';
import './MemoriesPage.css';

const REF_TYPES: Array<{ type: RefType; label: string }> = [
  { type: 'media', label: 'Media' },
  { type: 'memory', label: 'Memory' },
  { type: 'album', label: 'Album' },
  { type: 'person', label: 'Person' },
  { type: 'tag', label: 'Tag' },
];

function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

interface SaveStatus {
  kind: 'idle' | 'saving' | 'saved' | 'error';
  message?: string;
}

interface MemoryEditorProps {
  libraryId: string;
  memory: Memory;
  onDeleted: (id: string) => void;
  onChanged: (memory: Memory) => void;
}

export function MemoryEditor({ libraryId, memory, onDeleted, onChanged }: MemoryEditorProps) {
  const [draft, setDraft] = useState({ title: memory.title, body: memory.body });
  const [saved, setSaved] = useState<SaveStatus>({ kind: 'idle' });
  const [versions, setVersions] = useState<MemoryVersion[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const draftRef = useRef(draft);

  const memoryID = memory.id;

  // Keep the latest draft available to the (debounced) autosave timer.
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Load version history for this memory.
  useEffect(() => {
    let cancelled = false;
    apiGet<{ versions: MemoryVersion[] }>(`/libraries/${libraryId}/memories/${memoryID}/versions`)
      .then((resp) => {
        if (!cancelled) setVersions(resp.versions ?? []);
      })
      .catch(() => {
        // Version history is best-effort in the editor; ignore failures.
      });
    return () => {
      cancelled = true;
    };
  }, [memoryID, libraryId]);

  // Debounced autosave.
  const save = useCallback(() => {
    const current = draftRef.current;
    setSaved({ kind: 'saving' });
    apiPut<{ memory: Memory }>(`/libraries/${libraryId}/memories/${memoryID}`, {
      title: current.title,
      body: current.body,
    })
      .then((resp) => {
        onChanged(resp.memory);
        setSaved({ kind: 'saved' });
      })
      .catch((error: Error) => {
        setSaved({ kind: 'error', message: error.message });
      });
  }, [libraryId, memoryID, onChanged]);

  useEffect(() => {
    const timer = setTimeout(save, 900);
    return () => clearTimeout(timer);
  }, [draft.title, draft.body, save]);

  const insertFromTemplate = (type: RefType) => () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    insertRefAtCursor(textarea, `[[${type}:|]]`);
    setDraft({ ...draftRef.current, body: textarea.value });
  };

  const preview = useMemo(() => renderMarkdown(draft.body), [draft.body]);
  const refs = useMemo(() => extractRefs(draft.body), [draft.body]);

  const handleDelete = async () => {
    if (!window.confirm('Delete this memory?')) return;
    try {
      await apiDelete(`/libraries/${libraryId}/memories/${memoryID}`);
      onDeleted(memoryID);
    } catch (error) {
      setSaved({ kind: 'error', message: (error as Error).message });
    }
  };

  const loadVersion = (version: MemoryVersion) => {
    setDraft({ title: version.title, body: version.body });
  };

  return (
    <div className="editor" data-testid="memory-editor">
      <div className="editor-bar">
        <input
          className="editor-title"
          aria-label="Memory title"
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          placeholder="Untitled memory"
        />
        <span className={`save-status save-status-${saved.kind}`} role="status" aria-live="polite">
          {saved.kind === 'saving' && 'Saving…'}
          {saved.kind === 'saved' && 'Saved'}
          {saved.kind === 'error' && `Save failed: ${saved.message ?? ''}`}
          {saved.kind === 'idle' && 'Draft'}
        </span>
      </div>

      <div className="editor-toolbar">
        <span className="toolbar-label">Insert reference</span>
        <div className="ref-buttons">
          {REF_TYPES.map(({ type, label }) => (
            <button key={type} type="button" onClick={insertFromTemplate(type)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="editor-split">
        <textarea
          ref={textareaRef}
          className="editor-source"
          aria-label="Memory body"
          value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          placeholder={'Write in Markdown…\n\n[[album:|]]  [[person:|]]  [[media:|]]'}
        />
        <div
          className="editor-preview"
          aria-label="Markdown preview"
          dangerouslySetInnerHTML={{ __html: preview.html }}
        />
      </div>

      <div className="editor-footer">
        <div className="ref-chips">
          {refs.map((ref) => (
            <span className={`ref-chip ref-chip-${ref.type}`} key={`${ref.type}:${ref.id}`}>
              {ref.type}:{ref.id}
            </span>
          ))}
          {refs.length === 0 && <span className="muted">No references yet.</span>}
        </div>

        <div className="editor-actions">
          <span className="versions-label">Versions</span>
          <select
            aria-label="Restore an earlier version"
            value=""
            onChange={(e) => {
              const v = versions.find((x) => String(x.version) === e.target.value);
              if (v) loadVersion(v);
            }}
          >
            <option value="" disabled>
              Restore… ({versions.length})
            </option>
            {versions.map((v) => (
              <option key={v.version} value={String(v.version)}>
                v{v.version} · {formatDate(v.saved_at)}
              </option>
            ))}
          </select>
          <button type="button" className="danger-button" onClick={handleDelete}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

interface MemoriesPageProps {
  initialLibraryId?: string;
}

export default function MemoriesPage({ initialLibraryId }: MemoriesPageProps) {
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [libraryId, setLibraryId] = useState<string | null>(initialLibraryId ?? null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Load the library list; default to the first usable one.
  useEffect(() => {
    let cancelled = false;
    apiGet<{ libraries: Library[] }>('/libraries')
      .then((resp) => {
        if (cancelled) return;
        const libs = resp.libraries ?? [];
        setLibraries(libs);
        setLoading(false);
        if (libs.length > 0) {
          const preferred = libs.find((lib) => lib.id === libraryId) ?? libs[0]!;
          setLibraryId(preferred.id);
        }
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load memories when the library changes.
  useEffect(() => {
    if (!libraryId) return;
    let cancelled = false;
    apiGet<{ memories: Memory[] }>(`/libraries/${libraryId}/memories`)
      .then((resp) => {
        if (cancelled) return;
        setMemories(resp.memories ?? []);
        setError(null);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message);
        setMemories([]);
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId]);

  const activeMemory = activeId ? (memories.find((m) => m.id === activeId) ?? null) : null;

  const handleCreate = async () => {
    if (!libraryId) return;
    setError(null);
    try {
      const resp = await apiPost<{ memory: Memory }>(`/libraries/${libraryId}/memories`, {
        title: 'Untitled memory',
        body: '# New memory\n\nWrite something worth remembering…',
      });
      setMemories((prev) => [resp.memory, ...prev]);
      setActiveId(resp.memory.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleDelete = (id: string) => {
    setMemories((prev) => prev.filter((m) => m.id !== id));
    setActiveId(null);
  };

  const handleChanged = (updated: Memory) => {
    setMemories((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
  };

  if (libraries.length === 0 && loading) {
    return <div className="page-muted">Loading libraries…</div>;
  }

  if (libraries.length === 0) {
    return (
      <div className="page-muted">
        No libraries yet. Add a library from the server to start writing memories.
      </div>
    );
  }

  return (
    <main className="memories-page">
      <header className="page-header">
        <h1>Memories</h1>
        <div className="header-controls">
          <select
            aria-label="Library"
            value={libraryId ?? ''}
            onChange={(e) => {
              setLibraryId(e.target.value);
              setActiveId(null);
            }}
          >
            {libraries.map((lib) => (
              <option key={lib.id} value={lib.id}>
                {lib.name}
              </option>
            ))}
          </select>
          <button type="button" onClick={handleCreate}>
            New memory
          </button>
        </div>
      </header>

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      <div className="memories-layout" data-testid="memories-layout">
        <nav className="memory-list" aria-label="Memories">
          {memories.map((m) => (
            <button
              key={m.id}
              type="button"
              className={m.id === activeId ? 'memory-row active' : 'memory-row'}
              onClick={() => setActiveId(m.id)}
            >
              <span className="memory-row-title">{m.title}</span>
              <span className="memory-row-date">{formatDate(m.updated_at)}</span>
            </button>
          ))}
          {!loading && memories.length === 0 && (
            <p className="muted">No memories yet. Create your first one.</p>
          )}
        </nav>

        <section className="editor-pane">
          {libraryId && activeMemory && (
            <MemoryEditor
              key={activeMemory.id}
              libraryId={libraryId}
              memory={activeMemory}
              onDeleted={handleDelete}
              onChanged={handleChanged}
            />
          )}
          {!activeMemory && (
            <div className="editor-empty">
              <p className="muted">Select a memory to edit, or create a new one.</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
