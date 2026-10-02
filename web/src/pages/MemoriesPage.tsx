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
import { matchPath, useLocation, useNavigate } from 'react-router-dom';

import { useLibraryResource } from '../api/resources';
import {
  createMemory,
  deleteMemory,
  listMemories,
  listMemoryVersions,
  updateMemory,
} from '../api/queries';
import type { Library, Memory, MemoryVersion } from '../api/types';
import { ConfirmDialog } from '../components/Dialog';
import { LibraryGatePage } from '../components/LibraryGatePage';
import { thumbnailUrl } from '../components/media';
import { RefPicker } from '../components/RefPicker';
import {
  EmptyState,
  ErrorState,
  LibraryOfflineNotice,
  ListSkeleton,
  PageHeader,
} from '../components/States';
import { Icon } from '../components/ui/Icon';
import { Menu, useMenuButton } from '../components/ui/Menu';
import { insertRefAtCursor } from '../lib/editor';
import { formatDate as formatDay } from '../lib/dates';
import { extractExcerpt, extractRefs, renderMarkdown } from '../lib/markdown';
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

type EditorMode = 'write' | 'split' | 'preview';

const MODE_KEY = 'cairn.memory.mode';

function readMode(): EditorMode {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    return stored === 'write' || stored === 'preview' ? stored : 'split';
  } catch {
    return 'split';
  }
}

function MemoryEditor({
  libraryId,
  memory,
  onDeleted,
  onChanged,
  onBack,
}: {
  libraryId: string;
  memory: Memory;
  onDeleted: (id: string) => void;
  onChanged: (memory: Memory) => void;
  onBack: () => void;
}) {
  const [mode, setModeState] = useState<EditorMode>(readMode);
  const setMode = (next: EditorMode) => {
    setModeState(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // Not remembered.
    }
  };
  const versionsMenu = useMenuButton();
  const [linking, setLinking] = useState(false);
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
        <button
          type="button"
          className="icon-button"
          onClick={onBack}
          aria-label="Back to memories"
        >
          <Icon name="arrow-left" />
        </button>
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
          {saved.kind === 'error' && `Couldn't save: ${saved.message ?? ''}`}
          {saved.kind === 'idle' && 'Draft'}
        </span>
      </div>

      <div className="editor-toolbar">
        <div className="segmented" role="group" aria-label="Editor layout">
          {(['write', 'split', 'preview'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={mode === m ? 'segmented-item active' : 'segmented-item'}
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
            >
              {m === 'write' ? 'Write' : m === 'split' ? 'Split' : 'Preview'}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={linking ? 'button active' : 'button'}
          aria-expanded={linking}
          aria-controls="memory-ref-picker"
          onClick={() => setLinking((v) => !v)}
        >
          <Icon name="link" />
          Link photos, albums, people
        </button>
        <div className="editor-toolbar-end">
          <button
            type="button"
            className="button ghost-button"
            aria-haspopup="menu"
            aria-expanded={versionsMenu.open}
            onClick={versionsMenu.toggle}
            disabled={versions.length === 0}
          >
            <Icon name="clock" />
            History
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => setConfirmingDelete(true)}
            aria-label="Delete memory"
            title="Delete memory"
            data-testid="delete-memory"
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>

      {linking && (
        <div id="memory-ref-picker">
          <RefPicker libraryId={libraryId} onInsert={insertRef} />
        </div>
      )}

      <div className={`editor-split mode-${mode}`}>
        <textarea
          ref={textareaRef}
          className="editor-source"
          aria-label="Memory body"
          hidden={mode === 'preview'}
          value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          placeholder={
            'Write in Markdown…\n\nLink photos, albums, and people with the button above.'
          }
        />
        <div
          className="editor-preview markdown"
          aria-label="Markdown preview"
          hidden={mode === 'write'}
          dangerouslySetInnerHTML={{ __html: preview.html }}
        />
      </div>

      <div className="editor-footer">
        <div className="ref-chips" aria-label="Linked">
          {refs.map((ref) => (
            <span className={`ref-chip ref-chip-${ref.type}`} key={`${ref.type}:${ref.id}`}>
              {ref.label || `${ref.type}:${ref.id}`}
            </span>
          ))}
          {refs.length === 0 && <span className="muted">Nothing linked yet.</span>}
        </div>
        <p className="word-count">
          {wordCount} {wordCount === 1 ? 'word' : 'words'}
        </p>
      </div>

      {versionsMenu.anchor && (
        <Menu
          anchor={versionsMenu.anchor}
          align="end"
          label="Restore an earlier version"
          onClose={versionsMenu.close}
          items={versions.map((v) => ({
            id: String(v.version),
            label: `Version ${v.version} · ${formatDate(v.saved_at)}`,
            icon: 'restore',
            onSelect: () => setDraft({ title: v.title, body: v.body }),
          }))}
        />
      )}

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
  return (
    <LibraryGatePage title="Memories" className="memories-page">
      {(library) => <Memories library={library} />}
    </LibraryGatePage>
  );
}

/** The memory id in `/memories/:id`, read from the path so the page works in or out of `<Routes>`. */
function useMemoryIdFromPath(): string | null {
  const { pathname } = useLocation();
  return matchPath('/memories/:memoryId', pathname)?.params.memoryId ?? null;
}

function Memories({ library }: { library: Library }) {
  const libraryId = library.id;
  const navigate = useNavigate();
  const memoryId = useMemoryIdFromPath();

  /**
   * A memory created here is not in the list until it reloads; holding it
   * keeps the editor open at the exact moment you most want it. The list copy
   * wins once it arrives, so an edit made elsewhere shows up.
   */
  const [created, setCreated] = useState<Memory | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const memories = useLibraryResource<Memory[]>(
    useCallback(async (id: string) => (await listMemories(id)).memories ?? [], []),
  );

  const activeMemory = useMemo(() => {
    if (!memoryId) return null;
    return (
      memories.data?.find((m) => m.id === memoryId) ?? (created?.id === memoryId ? created : null)
    );
  }, [memoryId, memories.data, created]);

  const sorted = useMemo(
    () =>
      [...(memories.data ?? [])]
        .filter((m) => filter === '' || m.title.toLowerCase().includes(filter.toLowerCase()))
        .sort((a, b) =>
          (b.memory_date ?? b.updated_at).localeCompare(a.memory_date ?? a.updated_at),
        ),
    [memories.data, filter],
  );

  const create = () => {
    setCreating(true);
    setCreateError(null);
    createMemory(libraryId, {
      title: 'Untitled memory',
      body: '# New memory\n\nWrite something worth remembering…',
    })
      .then((resp) => {
        setCreated(resp.memory);
        memories.reload();
        navigate(`/memories/${resp.memory.id}`);
      })
      .catch((e: unknown) => setCreateError(e instanceof Error ? e.message : String(e)))
      .finally(() => setCreating(false));
  };

  const offline = library.status === 'offline';

  if (memoryId && activeMemory) {
    return (
      <main className="page memories-page memories-editing">
        <MemoryEditor
          key={activeMemory.id}
          libraryId={libraryId}
          memory={activeMemory}
          onBack={() => navigate('/memories')}
          onDeleted={() => {
            setCreated(null);
            memories.reload();
            navigate('/memories');
          }}
          onChanged={(memory) => {
            setCreated(memory);
            memories.reload();
          }}
        />
      </main>
    );
  }

  return (
    <main className="page memories-page">
      <PageHeader
        title="Memories"
        subtitle={
          memories.data && memories.data.length > 0
            ? `${memories.data.length} ${memories.data.length === 1 ? 'memory' : 'memories'}`
            : undefined
        }
        controls={
          !offline && (
            <button
              type="button"
              className="button primary-button"
              onClick={create}
              disabled={creating}
              data-testid="new-memory"
            >
              <Icon name="edit" />
              {creating ? 'Creating…' : 'New memory'}
            </button>
          )
        }
      />

      {offline && <LibraryOfflineNotice library={library} />}
      {memories.error && (
        <ErrorState
          message={memories.error}
          onRetry={memories.reload}
          title="Couldn't load memories"
        />
      )}
      {createError && (
        <p className="error-text" role="alert">
          {createError}
        </p>
      )}
      {memories.loading && <ListSkeleton rows={4} />}

      {memoryId && memories.data && !activeMemory && (
        <EmptyState title="Memory not found" icon="memory" testId="memory-missing">
          <p>It may have been deleted.</p>
        </EmptyState>
      )}

      {memories.data !== null && memories.data.length === 0 && (
        <EmptyState
          title="No memories yet"
          testId="memories-empty"
          icon="memory"
          action={
            !offline && (
              <button type="button" className="button primary-button" onClick={create}>
                Write your first memory
              </button>
            )
          }
        >
          <p>
            A memory is a note about something that mattered — a trip, a year, a person — with the
            photos it is about.
          </p>
        </EmptyState>
      )}

      {memories.data !== null && memories.data.length > 0 && (
        <>
          <div className="memory-filter">
            <Icon name="search" size={18} />
            <input
              type="search"
              aria-label="Filter memories"
              placeholder="Filter memories"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <ul className="memory-grid" data-testid="memories-layout" aria-label="Memories">
            {sorted.map((m) => (
              <li key={m.id}>
                <MemoryCard
                  libraryId={libraryId}
                  memory={m}
                  onOpen={() => navigate(`/memories/${m.id}`)}
                />
              </li>
            ))}
          </ul>
          {sorted.length === 0 && <p className="muted">No memory titles match “{filter}”.</p>}
        </>
      )}
    </main>
  );
}

/** A memory as a page from a journal: its first photo, date, title, and opening lines. */
function MemoryCard({
  libraryId,
  memory,
  onOpen,
}: {
  libraryId: string;
  memory: Memory;
  onOpen: () => void;
}) {
  const refs = useMemo(() => extractRefs(memory.body), [memory.body]);
  const media = refs.filter((r) => r.type === 'media');
  const cover = media[0]?.id;
  return (
    <button type="button" className="memory-card" onClick={onOpen}>
      {cover && (
        <span className="memory-card-cover">
          <img
            src={thumbnailUrl(libraryId, { id: cover })}
            alt=""
            loading="lazy"
            onError={(event) => {
              (event.currentTarget.parentElement as HTMLElement).hidden = true;
            }}
          />
        </span>
      )}
      <span className="memory-card-body">
        <span className="memory-card-date">
          {formatDay(memory.memory_date ?? memory.updated_at)}
        </span>
        <span className="memory-card-title">{memory.title || 'Untitled memory'}</span>
        <span className="memory-card-excerpt">{extractExcerpt(memory.body, 180)}</span>
        {media.length > 0 && (
          <span className="memory-card-meta">
            <Icon name="photo" size={14} />
            {media.length} {media.length === 1 ? 'photo' : 'photos'}
          </span>
        )}
      </span>
    </button>
  );
}
