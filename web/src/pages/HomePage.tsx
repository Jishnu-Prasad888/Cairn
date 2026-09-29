/**
 * Home — the landing page, and the first thing anyone sees after signing in.
 *
 * It answers the three questions a person actually opens Cairn with: what is in
 * my library, what do I want to look at now, and is anything broken. So: a row
 * of counts, a strip of recent photos, and a small server-status block.
 *
 * The counts come from one page-limited listing each rather than a full scan, so
 * the page stays fast on a library of a hundred thousand files. Collections are
 * small by nature (tags, albums, people) so those are counted directly.
 */

import { useCallback } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/authContext';
import { apiGet } from '../api/client';
import { useLibraryGate } from '../api/libraries';
import { useLibraryResource, useResource } from '../api/resources';
import {
  listAlbums,
  listFavorites,
  listFiles,
  listMemories,
  listPeople,
  listTags,
} from '../api/queries';
import type {
  FileListResponse,
  FileSummary,
  HealthResponse,
  Memory,
  VersionResponse,
} from '../api/types';
import {
  IconAlbum,
  IconFile,
  IconMemory,
  IconPeople,
  IconPhoto,
  IconStar,
  IconTag,
  IconVideo,
} from '../components/icons';
import { thumbnailUrl } from '../components/media';
import LibraryPicker from '../components/LibraryPicker';
import {
  EmptyState,
  ErrorState,
  LibraryOfflineNotice,
  LoadingState,
  NoLibrariesState,
  PageHeader,
} from '../components/States';
import './HomePage.css';

/** Everything the dashboard shows, fetched together so it loads once. */
interface HomeData {
  photoCount: number;
  videoCount: number;
  fileCount: number;
  albumCount: number;
  tagCount: number;
  memoryCount: number;
  favoriteCount: number;
  /** Null when the server has no face support, so the tile is hidden. */
  personCount: number | null;
  recent: FileSummary[];
  /** The most recently edited memories, newest first. */
  recentMemories: Memory[];
}

async function countByType(libraryId: string, type: 'photo' | 'video' | 'other'): Promise<number> {
  const resp = await listFiles(libraryId, { type, limit: 1 });
  return resp.total ?? 0;
}

export default function HomePage() {
  const gate = useLibraryGate();
  const { user } = useAuth();

  const home = useLibraryResource<HomeData>(
    useCallback(async (libraryId: string) => {
      const [photos, videos, files, albums, tags, memories, favorites, people, recentPage] =
        await Promise.all([
          countByType(libraryId, 'photo'),
          countByType(libraryId, 'video'),
          countByType(libraryId, 'other'),
          listAlbums(libraryId).then((r) => r.albums?.length ?? 0),
          listTags(libraryId).then((r) => r.tags?.length ?? 0),
          listMemories(libraryId).then((r) => r.memories ?? []),
          listFavorites(libraryId).then((r) => r.files?.length ?? 0),
          // A server without face support 404s this route; that is "not
          // available", not "zero people", so it resolves to null.
          listPeople(libraryId)
            .then((r) => r.people?.length ?? 0)
            .catch(() => null),
          listFiles(libraryId, {
            type: 'photo',
            sort: 'mod_time',
            order: 'desc',
            limit: 12,
          }),
        ]);

      return {
        photoCount: photos,
        videoCount: videos,
        fileCount: files,
        albumCount: albums,
        tagCount: tags,
        memoryCount: memories.length,
        recentMemories: [...memories]
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
          .slice(0, 4),
        favoriteCount: favorites,
        personCount: people,
        recent: (recentPage as FileListResponse).files ?? [],
      };
    }, []),
  );

  const server = useResource(
    useCallback(async () => {
      const [health, version] = await Promise.all([
        apiGet<HealthResponse>('/health'),
        apiGet<VersionResponse>('/version'),
      ]);
      return { health, version };
    }, []),
  );

  if (gate.kind === 'loading') {
    return (
      <main className="home">
        <LoadingState label="Loading your libraries…" />
      </main>
    );
  }

  const header = (
    <PageHeader
      title={user?.username ? `Welcome back, ${user.username}` : 'Welcome back'}
      subtitle="Your personal place for files, photos, videos, and memories."
      controls={<LibraryPicker />}
    />
  );

  if (gate.kind === 'error') {
    return (
      <main className="home">
        {header}
        <ErrorState message={gate.message} onRetry={home.reload} />
      </main>
    );
  }

  if (gate.kind === 'empty') {
    return (
      <main className="home">
        {header}
        <NoLibrariesState isAdmin={user?.role === 'admin'} />
      </main>
    );
  }

  const data = home.data;
  const count = (n: number | undefined) => (data ? (n ?? 0) : '—');
  const tiles = [
    {
      to: '/media?type=photo',
      label: 'Photos',
      n: data?.photoCount,
      tone: 'clay',
      icon: IconPhoto,
    },
    {
      to: '/media?type=video',
      label: 'Videos',
      n: data?.videoCount,
      tone: 'blue',
      icon: IconVideo,
    },
    { to: '/media?type=other', label: 'Files', n: data?.fileCount, tone: 'green', icon: IconFile },
    { to: '/memories', label: 'Memories', n: data?.memoryCount, tone: 'yellow', icon: IconMemory },
    { to: '/albums', label: 'Albums', n: data?.albumCount, tone: 'pink', icon: IconAlbum },
    { to: '/tags', label: 'Tags', n: data?.tagCount, tone: 'blue', icon: IconTag },
    { to: '/favorites', label: 'Favorites', n: data?.favoriteCount, tone: 'clay', icon: IconStar },
    {
      to: '/people',
      label: 'People',
      n: data?.personCount ?? undefined,
      tone: 'green',
      icon: IconPeople,
    },
  ].filter((tile) => tile.to !== '/people' || data?.personCount !== null);

  return (
    <main className="home">
      {header}

      {gate.library.status === 'offline' && <LibraryOfflineNotice library={gate.library} />}

      {home.error && <ErrorState message={home.error} onRetry={home.reload} />}
      {home.loading && <LoadingState label="Counting your library…" />}

      <section aria-label="Your library" className="home-tiles">
        {tiles.map((tile) => (
          <Link
            className={`home-tile tone-${tile.tone}`}
            to={tile.to}
            key={tile.to}
            data-testid={`home-tile-${tile.to}`}
          >
            <span className="home-tile-icon">{tile.icon}</span>
            <span className="home-tile-label">{tile.label}</span>
            <span className="home-tile-count">{count(tile.n)}</span>
          </Link>
        ))}
      </section>

      <div className="home-columns">
        <section aria-labelledby="home-recent-title" className="home-section">
          <div className="home-section-head">
            <h2 id="home-recent-title" className="home-heading">
              Recently added photos
            </h2>
            <Link to="/media?type=photo" className="link-button">
              See all photos
            </Link>
          </div>
          {data !== null && data.recent.length === 0 && !home.loading && (
            <EmptyState title="No photos yet" testId="home-no-photos">
              <p className="muted">
                Once an index pass has run over a library, the photos it finds appear here.
              </p>
            </EmptyState>
          )}
          {data !== null && data.recent.length > 0 && (
            <ul className="home-recent" data-testid="home-recent">
              {data.recent.map((file) => (
                <li key={file.id}>
                  <Link to="/media?type=photo" title={file.name}>
                    <img src={thumbnailUrl(gate.libraryId, file)} alt={file.name} loading="lazy" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="home-memories-title" className="home-section">
          <div className="home-section-head">
            <h2 id="home-memories-title" className="home-heading">
              Recent memories
            </h2>
            <Link to="/memories" className="link-button">
              All memories
            </Link>
          </div>
          {data !== null && data.recentMemories.length === 0 && !home.loading && (
            <EmptyState title="No memories yet" testId="home-no-memories">
              <p className="muted">Write down a day, a trip, or a thought.</p>
              <Link className="button" to="/memories">
                Write the first one
              </Link>
            </EmptyState>
          )}
          {data !== null && data.recentMemories.length > 0 && (
            <ul className="home-memory-list" data-testid="home-memories">
              {data.recentMemories.map((memory) => (
                <li key={memory.id}>
                  <Link to="/memories" className="home-memory">
                    <span className="home-memory-title">{memory.title || 'Untitled'}</span>
                    <span className="home-memory-date muted">
                      {new Date(memory.memory_date ?? memory.updated_at).toLocaleDateString()}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section aria-labelledby="home-server-title" className="home-server-section">
        <h2 id="home-server-title" className="visually-hidden">
          Server status
        </h2>
        <div className="home-server" role="status" aria-live="polite">
          {server.loading && <p className="muted">Checking the server…</p>}
          {server.error && (
            <p className="error-text">
              {server.error}{' '}
              <button type="button" className="link-button" onClick={server.reload}>
                Retry
              </button>
            </p>
          )}
          {server.data && (
            <dl className="home-server-rows">
              <div className="status-row">
                <dt>Status</dt>
                <dd>{server.data.health.status}</dd>
              </div>
              <div className="status-row">
                <dt>Database</dt>
                <dd>{server.data.health.database}</dd>
              </div>
              <div className="status-row">
                <dt>Version</dt>
                <dd>{server.data.version.version}</dd>
              </div>
              <div className="status-row">
                <dt>Commit</dt>
                <dd>{server.data.version.commit}</dd>
              </div>
            </dl>
          )}
        </div>
      </section>
    </main>
  );
}
