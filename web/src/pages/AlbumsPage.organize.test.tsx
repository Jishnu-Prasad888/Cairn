import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, libraryFixture, mockApi, originalFetch, renderPage } from '../test/harness';
import type { RouteHandler } from '../test/harness';
import AlbumsPage from './AlbumsPage';

const album = (id: string, name: string, created: string, library_id = 'lib1') => ({
  id,
  name,
  description: '',
  library_id,
  created_at: created,
  updated_at: created,
});

const lib1Albums = [
  album('a1', 'Beach', '2024-01-01T00:00:00Z'),
  album('a2', 'apples', '2025-06-01T00:00:00Z'),
  album('a3', 'Cats', '2023-03-01T00:00:00Z'),
  album('a4', 'Dogs', '2022-01-01T00:00:00Z'),
  album('a5', 'Eggs', '2021-01-01T00:00:00Z'),
  album('a6', 'Figs', '2020-01-01T00:00:00Z'),
];
const lib2Albums = [album('b1', 'Beach trip', '2026-01-01T00:00:00Z', 'lib2')];
const libraries = [
  libraryFixture(),
  libraryFixture({ id: 'lib2', name: 'Work', root: '/srv/work' }),
];

/** A fake /settings/albums that remembers patches, like the server. */
function setup(initial: Record<string, unknown> = {}, route = '/albums') {
  let settings = { sort: 'created_desc', pinned: [], hidden_libraries: [], ...initial };
  const rules: RouteHandler[] = [
    (url, init) => {
      if (!url.endsWith('/api/v1/settings/albums')) return undefined;
      if (init?.method === 'PATCH') {
        settings = { ...settings, ...JSON.parse(String(init.body)) };
      }
      return json({ settings });
    },
    (url) =>
      url.endsWith('/api/v1/libraries/lib1/albums') ? json({ albums: lib1Albums }) : undefined,
    (url) =>
      url.endsWith('/api/v1/libraries/lib2/albums') ? json({ albums: lib2Albums }) : undefined,
    (url) => (url.includes('/favorites') ? json({ files: [] }) : undefined),
  ];
  const fn = mockApi(rules, { libraries });
  renderPage(<AlbumsPage />, { libraries, route });
  return { fn, settings: () => settings };
}

const names = (testId: string) =>
  within(screen.getByTestId(testId))
    .getAllByRole('button', { name: /^(?!.*options)/ })
    .map((b) => b.querySelector('.album-card-name')?.textContent)
    .filter(Boolean);

describe('Albums: sort, pins, hidden libraries', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sorts by creation date or by name, and remembers it', async () => {
    const { settings } = setup({ hidden_libraries: ['lib2'] });
    await screen.findByTestId('albums-grid');
    expect(names('albums-grid')).toEqual(['apples', 'Beach', 'Cats', 'Dogs', 'Eggs', 'Figs']);
    await waitFor(() => expect(names('albums-grid')[0]).toBe('apples'));

    fireEvent.change(screen.getByTestId('album-sort'), { target: { value: 'name_desc' } });
    expect(names('albums-grid')).toEqual(['Figs', 'Eggs', 'Dogs', 'Cats', 'Beach', 'apples']);
    await waitFor(() => expect(settings().sort).toBe('name_desc'));
  });

  it('pins albums to the top, latest pin first, at most five', async () => {
    const { settings } = setup({ hidden_libraries: ['lib2'] });
    await screen.findByTestId('albums-grid');

    const pin = async (id: string) => {
      fireEvent.click(screen.getByTestId(`album-menu-${id}`));
      fireEvent.click(await screen.findByTestId(`pin-album-${id}`));
    };
    await pin('a3');
    await pin('a1');
    expect(names('albums-pinned')).toEqual(['Beach', 'Cats']);
    expect(names('albums-grid')).not.toContain('Beach');

    await pin('a4');
    await pin('a5');
    await pin('a6');
    await pin('a2');
    expect(await screen.findByText(/You can pin up to 5 albums/)).toBeInTheDocument();
    expect(names('albums-pinned')).toHaveLength(5);
    await waitFor(() =>
      expect(settings().pinned.map((p: { album_id: string }) => p.album_id)).toEqual([
        'a6',
        'a5',
        'a4',
        'a1',
        'a3',
      ]),
    );
  });

  it("hides a library's albums, and a search shows them folded away", async () => {
    const { settings } = setup();
    await screen.findByTestId('albums-grid');
    expect(names('albums-grid')).toContain('Beach trip');

    fireEvent.click(screen.getByTestId('album-libraries-button'));
    fireEvent.click(within(screen.getByTestId('album-libraries-panel')).getByLabelText('Work'));
    await waitFor(() => expect(names('albums-grid')).not.toContain('Beach trip'));
    await waitFor(() => expect(settings().hidden_libraries).toEqual(['lib2']));
  });

  it('lists search matches from hidden libraries in a closed section', async () => {
    setup({ hidden_libraries: ['lib2'] }, '/albums?q=beach');
    await screen.findByTestId('albums-grid');
    expect(names('albums-grid')).toEqual(['Beach']);

    const hidden = screen.getByTestId('albums-hidden-matches');
    expect(hidden).not.toHaveAttribute('open');
    expect(hidden).toHaveTextContent('1 match in hidden libraries');
    fireEvent.click(within(hidden).getByText(/match in hidden libraries/));
    expect(hidden).toHaveAttribute('open');
    expect(within(hidden).getByText('Beach trip')).toBeInTheDocument();
  });
});
