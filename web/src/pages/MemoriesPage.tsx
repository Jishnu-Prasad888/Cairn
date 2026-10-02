/**
 * Memories — personal stories built from words and library photos.
 *
 * The page is a list of memories beside the notebook editor
 * (memories/MemoryEditor). A memory has its own URL, /memories/:memoryId, so
 * it can be linked and reopened; on narrow screens the list and the editor
 * take turns instead of sitting side by side.
 *
 * Search runs on the server and covers titles, every text block, image
 * captions, descriptions, locations and tags.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { useAuth } from '../auth/authContext';
import { useLibraryGate } from '../api/libraries';
import { useLibraryResource } from '../api/resources';
import { listMemories } from '../api/queries';
import LibraryPicker from '../components/LibraryPicker';
import {
  EmptyState,
  ErrorState,
  LibraryOfflineNotice,
  LoadingState,
  NoLibrariesState,
  PageHeader,
} from '../components/States';
import { createMemoryDocument, getMemorySettings } from '../memories/api';
import { formatMemoryDate } from '../memories/format';
import { MemoryEditor } from '../memories/MemoryEditor';
import { newId } from '../memories/model';
import {
  DEFAULT_MEMORY_SETTINGS,
  type MemorySettings,
  type MemorySummary,
} from '../memories/types';
import '../memories/memories.css';
import './MemoriesPage.css';

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

export default function MemoriesPage() {
  const gate = useLibraryGate();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { memoryId } = useParams();
  const settings = useMemorySettings();

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setQuery(filter.trim()), 300);
    return () => clearTimeout(t);
  }, [filter]);

  const memories = useLibraryResource<MemorySummary[]>(
    useCallback(
      async (libraryId: string) =>
        ((await listMemories(libraryId, query ? { q: query } : {})).memories ??
          []) as unknown as MemorySummary[],
      [query],
    ),
  );

  const open = (id: string) => navigate(`/memories/${id}`);

  const create = () => {
    if (gate.kind !== 'ready') return;
    setCreating(true);
    setCreateError(null);
    createMemoryDocument(gate.libraryId, {
      title: 'Untitled memory',
      blocks: [{ id: newId(), type: 'text', markdown: '' }],
    })
      .then((resp) => {
        memories.reload();
        open(resp.memory.id);
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
      subtitle="Stories told in words and photos from your library."
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
    <main className={`memories-page${memoryId ? ' has-open-memory' : ''}`}>
      {header}

      {gate.library.status === 'offline' && <LibraryOfflineNotice library={gate.library} />}
      {memories.error && <ErrorState message={memories.error} onRetry={memories.reload} />}
      {createError && (
        <p className="error-text" role="alert">
          {createError}
        </p>
      )}

      <div className="memories-layout" data-testid="memories-layout">
        <nav className="memory-list" aria-label="Memories">
          <div className="memory-list-header">
            <input
              className="memory-filter-input"
              type="search"
              placeholder="Search memories, captions, tags…"
              aria-label="Search memories"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <span className="memory-list-count">{memories.data?.length ?? 0} memories</span>
          </div>
          {memories.loading && !memories.data && <LoadingState label="Loading memories…" />}
          {memories.data?.map((m) => (
            <button
              key={m.id}
              type="button"
              className={m.id === memoryId ? 'memory-row active' : 'memory-row'}
              aria-current={m.id === memoryId ? 'page' : undefined}
              onClick={() => open(m.id)}
            >
              <span className="memory-row-cover" aria-hidden="true">
                {m.cover?.available && m.cover.thumbnail_url ? (
                  <img src={m.cover.thumbnail_url} alt="" loading="lazy" />
                ) : null}
              </span>
              <span className="memory-row-text">
                <span className="memory-row-title">{m.title}</span>
                <span className="memory-row-date">
                  {formatMemoryDate(m.memory_date) || new Date(m.updated_at).toLocaleDateString()}
                  {m.location ? ` · ${m.location}` : ''}
                </span>
              </span>
            </button>
          ))}
          {memories.data !== null && memories.data.length === 0 && (
            <EmptyState
              title={query ? 'Nothing matches' : 'No memories yet'}
              testId="memories-empty"
            >
              <p className="muted">
                {query
                  ? 'Try other words — search covers text, captions and tags.'
                  : 'A memory is a story you tell with words and photos — a trip, a year, a person.'}
              </p>
            </EmptyState>
          )}
        </nav>

        <section className="editor-pane" aria-label="Memory">
          {memoryId ? (
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
          ) : (
            <div className="editor-empty">
              <p className="muted">Open a memory, or start a new one.</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
