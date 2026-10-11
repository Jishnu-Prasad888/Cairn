/**
 * Memories — two separate surfaces, like a document app.
 *
 * /memories is the landing page: a library of memories as a grid or a list,
 * with a "New memory" tile and one row of the most recent, then everything
 * else underneath. /memories/:memoryId is the memory itself, a focused editor
 * with a "← Memories" button back to the landing page (which remembers the
 * view, the search and the scroll position).
 *
 * Search runs on the server and covers titles, every text block, image
 * captions, descriptions, locations and tags.
 */

import { LayoutGrid, List, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { useAuth } from '../auth/authContext';
import { useLibraryGate } from '../api/libraries';
import { useAllLibrariesResource } from '../api/resources';
import { LibraryTag } from '../components/LibraryTag';
import { listMemories } from '../api/queries';
import {
  EmptyState,
  ErrorState,
  LibraryOfflineNotice,
  LoadingState,
  NoLibrariesState,
  PageHeader,
} from '../components/States';
import { PromptDialog } from '../components/Dialog';
import { createMemoryDocument, getMemorySettings } from '../memories/api';
import { formatMemoryDate } from '../memories/format';
import { MemoryEditor } from '../memories/MemoryEditor';
import { MemoryThumbnail } from '../memories/MemoryThumbnail';
import { newId } from '../memories/model';
import type { Library } from '../api/types';
import {
  DEFAULT_MEMORY_SETTINGS,
  memoryBackgroundClass,
  type MemorySettings,
  type MemorySummary,
} from '../memories/types';
import '../memories/memories.css';
import './MemoriesPage.css';

type ViewMode = 'grid' | 'list';

const VIEW_KEY = 'cairn.memories.view';
const QUERY_KEY = 'cairn.memories.query';
const SCROLL_KEY = 'cairn.memories.scroll';
/** Below this width the "recent" row becomes a swipeable strip. */
const STRIP_BELOW = 640;
const STRIP_COUNT = 6;
const CARD_MIN = 220;
const CARD_GAP = 16;

function read(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function write(storage: Storage, key: string, value: string) {
  try {
    storage.setItem(key, value);
  } catch {
    /* not remembered */
  }
}

function useMemorySettings(): MemorySettings {
  const [settings, setSettings] = useState<MemorySettings>(DEFAULT_MEMORY_SETTINGS);
  useEffect(() => {
    let cancelled = false;
    getMemorySettings()
      .then((r) => !cancelled && setSettings({ ...DEFAULT_MEMORY_SETTINGS, ...r.settings }))
      .catch(() => {
        /* defaults are a fine fallback */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return settings;
}

/** The page width, to know how many cards make up the single "recent" row. */
function useWidth(): [(el: HTMLElement | null) => void, number] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setWidth(Math.round(el.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, width || 1024];
}

function dateOf(m: MemorySummary): string {
  return formatMemoryDate(m.memory_date) || new Date(m.updated_at).toLocaleDateString();
}

export default function MemoriesPage() {
  const gate = useLibraryGate();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { memoryId } = useParams();
  const settings = useMemorySettings();
  // The page-aware top-bar search drives this page through `?q=`.
  const [params] = useSearchParams();
  const urlQ = params.get('q') ?? '';

  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [createLibraryId, setCreateLibraryId] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(() =>
    read(localStorage, VIEW_KEY) === 'list' ? 'list' : 'grid',
  );
  const [filter, setFilter] = useState(() =>
    urlQ ? urlQ : (read(sessionStorage, QUERY_KEY) ?? ''),
  );
  const [query, setQuery] = useState(() =>
    (urlQ || (read(sessionStorage, QUERY_KEY) ?? '')).trim(),
  );
  const [widthRef, width] = useWidth();

  useEffect(() => {
    const t = setTimeout(() => setQuery(filter.trim()), 300);
    return () => clearTimeout(t);
  }, [filter]);

  // A new `?q=` from the top-bar search (or a shared link) filters the page,
  // exactly as if it had been typed in its own search box. Only a *change* of
  // the URL query is applied, so typing in the page's own box is never undone
  // by the URL still carrying the old value.
  const lastUrlQRef = useRef(urlQ);
  useEffect(() => {
    if (!urlQ) {
      lastUrlQRef.current = '';
      return;
    }
    if (lastUrlQRef.current === urlQ) return;
    lastUrlQRef.current = urlQ;
    setFilter(urlQ);
    write(sessionStorage, QUERY_KEY, urlQ);
  }, [urlQ]);

  const memories = useAllLibrariesResource<MemorySummary>(
    useCallback(
      async (libraryId: string) =>
        ((await listMemories(libraryId, query ? { q: query } : {})).memories ??
          []) as unknown as MemorySummary[],
      [query],
    ),
  );

  const chooseView = (next: ViewMode) => {
    setView(next);
    write(localStorage, VIEW_KEY, next);
  };

  const changeFilter = (value: string) => {
    setFilter(value);
    write(sessionStorage, QUERY_KEY, value);
  };

  const open = (id: string) => {
    write(sessionStorage, SCROLL_KEY, String(window.scrollY));
    navigate(`/memories/${id}`);
  };

  // Coming back from a memory: put the landing page where it was.
  const listReady = memories.data !== null && !memoryId;
  useEffect(() => {
    if (!listReady) return;
    const y = Number(read(sessionStorage, SCROLL_KEY));
    if (y > 0) window.scrollTo(0, y);
    write(sessionStorage, SCROLL_KEY, '0');
  }, [listReady]);

  const startCreate = () => {
    if (gate.kind !== 'ready') return;
    setCreateLibraryId(gate.primaryId || gate.libraryId);
    setCreating(true);
    setCreateError(null);
  };

  const create = (libraryId: string, title = 'Untitled memory') => {
    setSaving(true);
    setCreateError(null);
    createMemoryDocument(libraryId, {
      title,
      blocks: [{ id: newId(), type: 'text', markdown: '' }],
    })
      .then((resp) => {
        setSaving(false);
        setCreating(false);
        memories.reload();
        navigate(`/memories/${resp.memory.id}`);
      })
      .catch((e: unknown) => {
        setCreateError(e instanceof Error ? e.message : String(e));
        setSaving(false);
      });
  };

  if (gate.kind === 'loading') {
    return (
      <main className="memories-page">
        <LoadingState label="Loading libraries…" />
      </main>
    );
  }

  const header = (
    <PageHeader title="Memories" subtitle="Stories told in words and photos from your library." />
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

  // A memory is open: nothing else on the page.
  if (memoryId) {
    return (
      <main className="memories-page memory-open">
        {gate.library.status === 'offline' && <LibraryOfflineNotice library={gate.library} />}
        <MemoryEditor
          key={`${gate.libraryId}/${memoryId}`}
          libraryId={gate.libraryId}
          memoryId={memoryId}
          settings={settings}
          onBack={() => navigate('/memories')}
          onDeleted={() => {
            memories.reload();
            navigate('/memories');
          }}
          onSummaryChange={memories.reload}
        />
      </main>
    );
  }

  const list = memories.data ?? [];
  const searching = query !== '';
  const strip = width < STRIP_BELOW;
  const columns = Math.max(1, Math.floor((width + CARD_GAP) / (CARD_MIN + CARD_GAP)));
  // The single "recent" row: the New tile plus as many memories as fit beside
  // it. Everything else goes under the divider — it never wraps into a second
  // recent row.
  const recentCount = strip ? STRIP_COUNT : Math.max(0, columns - 1);
  const recent = searching ? [] : list.slice(0, recentCount);
  const rest = searching ? list : list.slice(recentCount);

  const newTile = (
    <button
      type="button"
      className={view === 'grid' ? 'mem-card mem-new' : 'mem-row mem-new'}
      onClick={startCreate}
      disabled={creating}
      data-testid="new-memory"
    >
      <span className="mem-new-plus" aria-hidden="true">
        <Plus size={view === 'grid' ? 36 : 20} />
      </span>
      <span className="mem-new-label">New memory</span>
    </button>
  );

  const card = (m: MemorySummary) => (
    <button
      key={`${m.library_id || gate.libraryId}/${m.id}`}
      type="button"
      className={`mem-card ${memoryBackgroundClass(m.background)}`}
      onClick={() => open(m.id)}
    >
      <span className="mem-card-cover">
        <MemoryThumbnail
          libraryId={gate.libraryId}
          itemLibraryId={m.library_id || gate.libraryId}
          memoryId={m.id}
          revision={m.revision}
          fallbackCover={m.cover?.available ? m.cover.thumbnail_url : undefined}
        />
        <LibraryTag libraryId={m.library_id} corner />
      </span>
      <span className="mem-card-text">
        <span className="mem-card-title">{m.title || 'Untitled memory'}</span>
        <span className="mem-card-date">{dateOf(m)}</span>
      </span>
    </button>
  );

  const row = (m: MemorySummary) => (
    <button
      key={`${m.library_id || gate.libraryId}/${m.id}`}
      type="button"
      className={`mem-row ${memoryBackgroundClass(m.background)}`}
      onClick={() => open(m.id)}
    >
      <span className="mem-row-title">{m.title || 'Untitled memory'}</span>
      <span className="mem-row-meta">
        <LibraryTag libraryId={m.library_id} />
        {m.location && <span>{m.location}</span>}
        {m.tags.length > 0 && <span>{m.tags.map((t) => `#${t}`).join(' ')}</span>}
      </span>
      <span className="mem-row-date">{dateOf(m)}</span>
      <span className="mem-row-modified">Edited {new Date(m.updated_at).toLocaleDateString()}</span>
    </button>
  );

  return (
    <main className="memories-page" ref={widthRef}>
      {header}

      {gate.library.status === 'offline' && <LibraryOfflineNotice library={gate.library} />}
      {memories.error && <ErrorState message={memories.error} onRetry={memories.reload} />}
      {createError && !creating && (
        <p className="error-text" role="alert">
          {createError}
        </p>
      )}

      <div className="mem-toolbar">
        <label className="mem-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            placeholder="Search memories, captions, tags…"
            aria-label="Search memories"
            value={filter}
            onChange={(e) => changeFilter(e.target.value)}
          />
        </label>
        <div className="segmented" role="group" aria-label="View">
          <button
            type="button"
            className={view === 'grid' ? 'segment active' : 'segment'}
            aria-pressed={view === 'grid'}
            aria-label="Grid view"
            onClick={() => chooseView('grid')}
          >
            <LayoutGrid size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={view === 'list' ? 'segment active' : 'segment'}
            aria-pressed={view === 'list'}
            aria-label="List view"
            onClick={() => chooseView('list')}
          >
            <List size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      {memories.loading && !memories.data && <LoadingState label="Loading memories…" />}

      {memories.data && (
        <div data-testid="memories-layout">
          {view === 'grid' ? (
            <>
              <div
                className={strip ? 'mem-top mem-strip' : 'mem-top'}
                style={topStyle(strip, columns)}
              >
                {newTile}
                {recent.map(card)}
              </div>
              {rest.length > 0 && (
                <>
                  <hr className="mem-divider" />
                  <h2 className="mem-heading">{searching ? 'Results' : 'All memories'}</h2>
                  <div className="mem-grid">{rest.map(card)}</div>
                </>
              )}
            </>
          ) : (
            <>
              <div className="mem-list">{newTile}</div>
              {list.length > 0 && (
                <>
                  <h2 className="mem-heading">{searching ? 'Results' : 'Recent memories'}</h2>
                  <div className="mem-list">{list.map(row)}</div>
                </>
              )}
            </>
          )}
          {list.length === 0 && (
            <EmptyState
              title={searching ? 'Nothing matches' : 'No memories yet'}
              testId="memories-empty"
            >
              <p className="muted">
                {searching
                  ? 'Try other words — search covers text, captions and tags.'
                  : 'A memory is a story you tell with words and photos — a trip, a year, a person.'}
              </p>
            </EmptyState>
          )}
        </div>
      )}

      <PromptDialog
        open={creating}
        title="New memory"
        label="Memory title"
        placeholder="Untitled memory"
        busy={saving}
        error={createError}
        onCancel={() => {
          setCreating(false);
          setCreateError(null);
        }}
        control={({ value, setValue }) => (
          <NewMemoryFields
            name={value}
            onNameChange={setValue}
            libraries={gate.kind === 'ready' ? gate.libraries : []}
            libraryId={createLibraryId ?? (gate.kind === 'ready' ? gate.primaryId : '')}
            onLibraryChange={setCreateLibraryId}
          />
        )}
        onConfirm={(name) => {
          if (!createLibraryId && gate.kind === 'ready') {
            setCreateLibraryId(gate.primaryId);
          }
          const lib = createLibraryId ?? (gate.kind === 'ready' ? gate.primaryId : '');
          if (!lib) return;
          create(lib, name || 'Untitled memory');
        }}
      />
    </main>
  );
}

function NewMemoryFields({
  name,
  onNameChange,
  libraries,
  libraryId,
  onLibraryChange,
}: {
  name: string;
  onNameChange: (name: string) => void;
  libraries: Library[];
  libraryId: string;
  onLibraryChange: (id: string | null) => void;
}) {
  return (
    <>
      <label className="dialog-label" htmlFor="new-memory-title">
        Memory title
      </label>
      <input
        id="new-memory-title"
        className="dialog-input"
        type="text"
        placeholder="Untitled memory"
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
      />
      {libraries.length > 1 && (
        <>
          <label className="dialog-label" htmlFor="new-memory-library">
            Library
          </label>
          <select
            id="new-memory-library"
            className="dialog-input"
            value={libraryId}
            onChange={(event) => onLibraryChange(event.target.value)}
            data-testid="new-memory-library"
          >
            {libraries.map((lib) => (
              <option key={lib.id} value={lib.id} disabled={lib.status === 'offline'}>
                {lib.name}
                {lib.status === 'offline' ? ' · offline' : ''}
              </option>
            ))}
          </select>
        </>
      )}
    </>
  );
}

function topStyle(strip: boolean, columns: number) {
  return strip ? undefined : { gridTemplateColumns: `repeat(${columns}, ${CARD_MIN}px)` };
}
