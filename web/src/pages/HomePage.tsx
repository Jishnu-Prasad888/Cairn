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
import type { FileListResponse, FileSummary, HealthResponse, VersionResponse } from '../api/types';
import Brand from '../components/Brand';
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
          listMemories(libraryId).then((r) => r.memories?.length ?? 0),
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
        memoryCount: memories,
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
  const tiles = [
    { to: '/photos', label: 'Photos', count: data?.photoCount ?? null, hint: 'Pictures on disk' },
    { to: '/videos', label: 'Videos', count: data?.videoCount ?? null, hint: 'Clips and recordings' },
    { to: '/files', label: 'Files', count: data?.fileCount ?? null, hint: 'Documents and other' },
    {
      to: '/memories',
      label: 'Memories',
      count: data?.memoryCount ?? null,
      hint: 'Notes you have written',
    },
    {
      to: '/people',
      label: 'People',
      count: data?.personCount ?? null,
      hint: 'Faces you have named',
    },
    { to: '/albums', label: 'Albums', count: data?.albumCount ?? null, hint: 'Groupings' },
    { to: '/tags', label: 'Tags', count: data?.tagCount ?? null, hint: 'Labels' },
    {
      to: '/favorites',
      label: 'Favorites',
      count: data?.favoriteCount ?? null,
      hint: 'The ones you kept',
    },
  ].filter((tile) => tile.to !== '/people' || data?.personCount !== null);

  return (
    <main className="home">
      <header className="home-header">
        <h1>
          <Brand>Cairn</Brand>
        </h1>
        <p className="tagline">Your personal place for files, photos, videos, and memories.</p>
      </header>

      {header}

      {gate.library.status === 'offline' && <LibraryOfflineNotice library={gate.library} />}

      {home.error && <ErrorState message={home.error} onRetry={home.reload} />}
      {home.loading && <LoadingState label="Counting your library…" />}

      <section aria-labelledby="home-shortcuts-title" className="home-section">
        <h2 id="home-shortcuts-title" className="visually-hidden">
          Your library
        </h2>
        <div className="home-tiles">
          {tiles.map((tile) => (
            <Link className="home-tile" to={tile.to} key={tile.to} data-testid={`home-tile-${tile.to}`}>
              <span className="home-tile-count">{tile.count === null ? '—' : tile.count}</span>
              <span className="home-tile-label">{tile.label}</span>
              <span className="home-tile-hint">{tile.hint}</span>
            </Link>
          ))}
        </div>
      </section>

      <section aria-labelledby="home-recent-title" className="home-section">
        <div className="home-section-head">
          <h2 id="home-recent-title">Recently added photos</h2>
          <Link to="/photos" className="link-button">
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
                <Link to={`/photos?file=${file.id}`} title={file.name}>
                  <img src={thumbnailUrl(gate.libraryId, file)} alt={file.name} loading="lazy" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="home-server-title" className="home-section">
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

      <footer className="home-footer">
        <p className="muted">
          Cairn indexes your media in place — your files are never moved or modified.
        </p>
      </footer>
    </main>
  );
}
