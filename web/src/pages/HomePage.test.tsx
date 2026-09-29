import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiError, fileFixture, json, mockApi, originalFetch, renderPage } from '../test/harness';
import HomePage from './HomePage';

const health = { status: 'ok', database: 'ok' };
const version = {
  version: 'dev',
  commit: 'abc',
  build_date: '2026-09-22',
  go_version: 'go1.26.4',
  platform: 'linux/amd64',
};

interface Options {
  /** Total reported for each media type. */
  totals?: { photo?: number; video?: number; other?: number };
  recent?: typeof recent;
  people?: { people: unknown[] } | 'unsupported';
  memories?: unknown[];
}

const recent = {
  files: [fileFixture({ id: 'f1' }), fileFixture({ id: 'f2', name: 'IMG_0002.png' })],
};

function setup(options: Options = {}) {
  const totals = options.totals ?? {};
  const recentFiles = options.recent ?? recent;
  const fn = mockApi([
    (url) => (url.endsWith('/api/v1/health') ? json(health) : undefined),
    (url) => (url.endsWith('/api/v1/version') ? json(version) : undefined),
    (url) => {
      if (!url.includes('/api/v1/libraries/lib1/files')) return undefined;
      if (url.includes('type=photo')) {
        return json({ ...recentFiles, total: totals.photo ?? 2 });
      }
      if (url.includes('type=video')) return json({ files: [], total: totals.video ?? 0 });
      if (url.includes('type=other')) return json({ files: [], total: totals.other ?? 7 });
      return json({ files: [], total: 0 });
    },
    (url) =>
      url.endsWith('/api/v1/libraries/lib1/albums') ? json({ albums: [{ id: 'a1' }] }) : undefined,
    (url) => (url.endsWith('/api/v1/libraries/lib1/tags') ? json({ tags: [] }) : undefined),
    (url) =>
      url.endsWith('/api/v1/libraries/lib1/memories')
        ? json({ memories: options.memories ?? [] })
        : undefined,
    (url) => (url.endsWith('/api/v1/libraries/lib1/favorites') ? json({ files: [] }) : undefined),
    (url) => {
      if (!url.endsWith('/api/v1/libraries/lib1/people')) return undefined;
      if (options.people === 'unsupported') {
        return json({ error: { code: 'NOT_FOUND', message: 'no faces', request_id: '1' } }, 404);
      }
      return json(options.people ?? { people: [{ id: 'p1' }, { id: 'p2' }] });
    },
  ]);
  renderPage(<HomePage />);
  return fn;
}

describe('HomePage', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('greets the signed-in account', async () => {
    setup();

    expect(
      await screen.findByRole('heading', { name: 'Welcome back, jishnu' }),
    ).toBeInTheDocument();
  });

  it('counts each collection into a shortcut tile', async () => {
    setup({ totals: { photo: 128, video: 4, other: 7 } });

    // The tiles render immediately with a placeholder; the counts land when the
    // dashboard's parallel listing resolves.
    const photos = await screen.findByTestId('home-tile-/media?type=photo');
    expect(await within(photos).findByText('128')).toBeInTheDocument();
    expect(within(photos).getByText('Photos')).toBeInTheDocument();
    expect(
      await within(screen.getByTestId('home-tile-/media?type=video')).findByText('4'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('home-tile-/media?type=other')).getByText('7'),
    ).toBeInTheDocument();
    expect(within(screen.getByTestId('home-tile-/albums')).getByText('1')).toBeInTheDocument();
    expect(within(screen.getByTestId('home-tile-/people')).getByText('2')).toBeInTheDocument();
  });

  it('hides the people tile when the build has no face support', async () => {
    setup({ people: 'unsupported' });

    // The tile is only dropped once the people listing has actually failed, so
    // wait for the rest of the dashboard to settle first.
    const photos = await screen.findByTestId('home-tile-/media?type=photo');
    await within(photos).findByText('2');
    expect(screen.queryByTestId('home-tile-/people')).not.toBeInTheDocument();
    expect(screen.getByTestId('home-tile-/tags')).toBeInTheDocument();
  });

  it('links each recent photo into the media browser', async () => {
    setup();

    const strip = await screen.findByTestId('home-recent');
    const links = within(strip).getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', '/media?type=photo');
  });

  it('shows an empty state when the library has no photos yet', async () => {
    setup({ recent: { files: [] } });

    expect(await screen.findByTestId('home-no-photos')).toBeInTheDocument();
  });

  it('lists the most recently edited memories, newest first', async () => {
    const memory = (id: string, title: string, updated_at: string) => ({
      id,
      title,
      body: '',
      deleted: false,
      created_at: updated_at,
      updated_at,
    });
    setup({
      memories: [
        memory('m1', 'Old trip', '2026-01-01T00:00:00Z'),
        memory('m2', 'Birthday', '2026-09-01T00:00:00Z'),
      ],
    });

    const list = await screen.findByTestId('home-memories');
    const titles = within(list)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(titles[0]).toContain('Birthday');
    expect(titles[1]).toContain('Old trip');
  });

  it('invites the first memory when there are none', async () => {
    setup();

    expect(await screen.findByTestId('home-no-memories')).toBeInTheDocument();
  });

  it('shows server and version status after loading', async () => {
    setup();

    await waitFor(() => {
      expect(screen.getByText('dev')).toBeInTheDocument();
    });
    expect(screen.getByText('abc')).toBeInTheDocument();
    const rows = screen.getByText('Status').closest('dl') as HTMLElement;
    expect(within(rows).getByText('Database')).toBeInTheDocument();
    expect(within(rows).getByText('Commit')).toBeInTheDocument();
    expect(within(rows).getAllByText('ok')).toHaveLength(2);
  });

  it('shows an error and a retry action when the status endpoints fail', async () => {
    mockApi([
      (url) =>
        url.endsWith('/api/v1/health') || url.endsWith('/api/v1/version')
          ? apiError(503, 'UNAVAILABLE', 'Service unavailable')
          : undefined,
      (url) =>
        url.includes('/api/v1/libraries/lib1/files') ? json({ files: [], total: 0 }) : undefined,
      (url) => (url.endsWith('/api/v1/libraries/lib1/albums') ? json({ albums: [] }) : undefined),
      (url) => (url.endsWith('/api/v1/libraries/lib1/tags') ? json({ tags: [] }) : undefined),
      (url) =>
        url.endsWith('/api/v1/libraries/lib1/memories') ? json({ memories: [] }) : undefined,
      (url) => (url.endsWith('/api/v1/libraries/lib1/favorites') ? json({ files: [] }) : undefined),
      (url) => (url.endsWith('/api/v1/libraries/lib1/people') ? json({ people: [] }) : undefined),
    ]);
    renderPage(<HomePage />);

    const status = await screen.findByText(/Service unavailable/);
    expect(status).toBeInTheDocument();
    expect(
      within(status.parentElement as HTMLElement).getByRole('button', { name: 'Retry' }),
    ).toBeInTheDocument();
  });

  it('reports a library-list failure instead of rendering an empty dashboard', async () => {
    mockApi([
      (url) =>
        url.endsWith('/api/v1/libraries')
          ? apiError(500, 'INTERNAL', 'Libraries are unavailable.')
          : undefined,
    ]);
    renderPage(<HomePage />);

    expect(await screen.findByText('Libraries are unavailable.')).toBeInTheDocument();
    expect(screen.queryByTestId('home-tile-/media?type=photo')).not.toBeInTheDocument();
  });

  it('offers the library picker and a way out when there are no libraries', async () => {
    mockApi([], { libraries: [] });
    renderPage(<HomePage />, { libraries: [] });

    expect(await screen.findByTestId('no-libraries')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a library' })).toHaveAttribute(
      'href',
      '/libraries',
    );
  });
});
