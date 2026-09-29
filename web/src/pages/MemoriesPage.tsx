/**
 * Memories — long-form Markdown documents about a library's media.
 *
 * This is the Obsidian-shaped editor the spec asks for: split source/preview,
 * debounced autosave, version history you can restore from, and references to
 * other things in the library. References are the part that used to be a row of
 * buttons inserting `[[album:|]]` and leaving the user to find the id; they
 * now go through a search picker, because the spec is explicit that nobody
 * should have to type an id.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../auth/authContext';
import { useLibraryGate } from '../api/libraries';
import { useLibraryResource } from '../api/resources';
import {
  createMemory,
  deleteMemory,
  listMemories,
  listMemoryVersions,
  updateMemory,
} from '../api/queries';
import type { Memory, MemoryVersion } from '../api/types';
import { ConfirmDialog } from '../components/Dialog';
import LibraryPicker from '../components/LibraryPicker';
import { RefPicker } from '../components/RefPicker';
import {
  EmptyState,
  ErrorState,
  LibraryOfflineNotice,
  LoadingState,
  NoLibrariesState,
  PageHeader,
} from '../components/States';
import { insertRefAtCursor } from '../lib/editor';
import { extractRefs, renderMarkdown } from '../lib/markdown';
import './MemoriesPage.css';

function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

interface SaveStatus {
  kind: 'idle' | 'saving' | 'saved' | 'error';
  message?: string | undefined;
}

function MemoryEditor({
  libraryId,
  memory,
  onDeleted,
  onChanged,
}: {
  libraryId: string;
  memory: Memory;
  onDeleted: (id: string) => void;
  onChanged: (memory: Memory) => void;
}) {
  const [draft, setDraft] = useState({ title: memory.title, body: memory.body });
  const [saved, setSaved] = useState<SaveStatus>({ kind: 'idle' });
  const [versions, setVersions] = useState<MemoryVersion[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const draftRef = useRef(draft);

  const memoryId = memory.id;

  // Keep the latest draft available to the (debounced) autosave timer.
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Version history is best-effort in the editor; a failure here must not stop
  // someone from writing.
  useEffect(() => {
    let cancelled = false;
    listMemoryVersions(libraryId, memoryId)
      .then((versions) => {
        if (!cancelled) setVersions(versions.versions ?? []);
      })
      .catch(() => {
        /* ignored on purpose */
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId, memoryId]);

  const save = useCallback(() => {
    const current = draftRef.current;
    setSaved({ kind: 'saving' });
    updateMemory(libraryId, memoryId, { title: current.title, body: current.body })
      .then((resp) => {
        onChanged(resp.memory);
        setSaved({ kind: 'saved' });
      })
      .catch((error: Error) => {
        setSaved({ kind: 'error', message: error.message });
      });
  }, [libraryId, memoryId, onChanged]);

  useEffect(() => {
    const timer = setTimeout(save, 900);
    return () => clearTimeout(timer);
  }, [draft.title, draft.body, save]);

  const insertRef = (ref: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    insertRefAtCursor(textarea, ref);
    setDraft({ ...draftRef.current, body: textarea.value });
  };

  const preview = useMemo(() => renderMarkdown(draft.body), [draft.body]);
  const refs = useMemo(() => extractRefs(draft.body), [draft.body]);

  const remove = () => {
    setDeleting(true);
    setDeleteError(null);
    deleteMemory(libraryId, memoryId)
      .then(() => {
        setConfirmingDelete(false);
        onDeleted(memoryId);
      })
      .catch((e: unknown) => setDeleteError(e instanceof Error ? e.message : String(e)))
      .finally(() => setDeleting(false));
  };

  const wordCount = draft.body.trim() === '' ? 0 : draft.body.trim().split(/\s+/).length;

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
        <span className="save-status" title="Keyboard shortcuts">
          ⌘S saves · ⌃Z undoes
        </span>
      </div>

      <RefPicker libraryId={libraryId} onInsert={insertRef} />

      <div className="editor-split">
        <textarea
          ref={textareaRef}
          className="editor-source"
          aria-label="Memory body"
          value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          placeholder={
            'Write in Markdown…\n\nUse the picker above to link to photos, albums, or people.'
          }
        />
        <div
          className="editor-preview"
          aria-label="Markdown preview"
          dangerouslySetInnerHTML={{ __html: preview.html }}
        />
      </div>
      <p className="word-count">{wordCount} words</p>

      <div className="editor-footer">
        <div className="ref-chips">
          {refs.map((ref) => (
            <span className={`ref-chip ref-chip-${ref.type}`} key={`${ref.type}:${ref.id}`}>
              {ref.label || `${ref.type}:${ref.id}`}
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
              if (v) setDraft({ title: v.title, body: v.body });
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
          <button
            type="button"
            className="danger-button"
            onClick={() => setConfirmingDelete(true)}
            data-testid="delete-memory"
          >
            Delete
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        title="Delete this memory?"
        destructive
        confirmLabel="Delete"
        busy={deleting}
        error={deleteError}
        message={
          <p>
            <strong>{draft.title || 'Untitled memory'}</strong> will be removed. Versions are kept,
            so nothing you wrote is lost — but the memory itself leaves your list.
          </p>
        }
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={remove}
        testId="delete-memory-dialog"
      />
    </div>
  );
}

export default function MemoriesPage() {
  const gate = useLibraryGate();
  const { user } = useAuth();

  /**
   * The open memory is held, not derived by id alone. A memory created here is
   * not in the list until the list reloads, and resolving purely by id made the
   * editor close the instant you created something — the exact moment you most
   * want it open. The list copy still wins once it arrives, so an external edit
   * shows up.
   */
  const [active, setActive] = useState<Memory | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [memFilter, setMemFilter] = useState('');

  const memories = useLibraryResource<Memory[]>(
    useCallback(async (libraryId: string) => (await listMemories(libraryId)).memories ?? [], []),
  );

  const activeId = active?.id ?? null;
  const activeMemory = useMemo(
    () => (activeId ? (memories.data?.find((m) => m.id === activeId) ?? active) : null),
    [active, activeId, memories.data],
  );

  const visibleMemories =
    memories.data?.filter(
      (m) => memFilter === '' || m.title.toLowerCase().includes(memFilter.toLowerCase()),
    ) ?? [];

  const create = () => {
    if (gate.kind !== 'ready') return;
    setCreating(true);
    setCreateError(null);
    createMemory(gate.libraryId, {
      title: 'Untitled memory',
      body: '# New memory\n\nWrite something worth remembering…',
    })
      .then((resp) => {
        setActive(resp.memory);
        memories.reload();
      })
      .catch((e: unknown) => setCreateError(e instanceof Error ? e.message : String(e)))
      .finally(() => setCreating(false));
  };

  if (gate.kind === 'loading') {
    return (
      <main className="memories-page">
        <LoadingState label="Loading libraries…" />
      </main>
    );
  }

  const header = (
    <PageHeader
      title="Memories"
      subtitle="Long-form notes written in Markdown, with links to the media they are about."
      controls={
        <>
          <LibraryPicker />
          <button
            type="button"
            className="button primary-button"
            onClick={create}
            disabled={creating || gate.kind !== 'ready'}
            data-testid="new-memory"
          >
            {creating ? 'Creating…' : 'New memory'}
          </button>
        </>
      }
    />
  );

  if (gate.kind === 'error') {
    return (
      <main className="memories-page">
        {header}
        <ErrorState message={gate.message} onRetry={memories.reload} />
      </main>
    );
  }

  if (gate.kind === 'empty') {
    return (
      <main className="memories-page">
        {header}
        <NoLibrariesState isAdmin={user?.role === 'admin'} />
      </main>
    );
  }

  return (
    <main className="memories-page">
      {header}

      {gate.library.status === 'offline' && <LibraryOfflineNotice library={gate.library} />}
      {memories.error && <ErrorState message={memories.error} onRetry={memories.reload} />}
      {createError && (
        <p className="error-text" role="alert">
          {createError}
        </p>
      )}
      {memories.loading && <LoadingState label="Loading memories…" />}

      <div className="memories-layout" data-testid="memories-layout">
        <nav className="memory-list" aria-label="Memories">
          <div className="memory-list-header">
            <span className="memory-list-count">{memories.data?.length ?? 0} memories</span>
            <input
              className="memory-filter-input"
              type="search"
              placeholder="Filter memories…"
              value={memFilter}
              onChange={(e) => setMemFilter(e.target.value)}
            />
          </div>
          {visibleMemories.map((m) => (
            <button
              key={m.id}
              type="button"
              className={m.id === activeId ? 'memory-row active' : 'memory-row'}
              aria-current={m.id === activeId ? 'true' : undefined}
              onClick={() => setActive(m)}
            >
              <span className="memory-row-title">{m.title}</span>
              <span className="memory-row-date">{formatDate(m.updated_at)}</span>
            </button>
          ))}
          {memories.data !== null && memories.data.length === 0 && (
            <EmptyState title="No memories yet" testId="memories-empty">
              <p className="muted">
                A memory is a note you write about something — a trip, a year, a person. Write it in
                Markdown and link to the photos it is about.
              </p>
            </EmptyState>
          )}
        </nav>

        <section className="editor-pane">
          {activeMemory && (
            <MemoryEditor
              key={activeMemory.id}
              libraryId={gate.libraryId}
              memory={activeMemory}
              onDeleted={() => {
                setActive(null);
                memories.reload();
              }}
              onChanged={(memory) => {
                setActive(memory);
                memories.reload();
              }}
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
