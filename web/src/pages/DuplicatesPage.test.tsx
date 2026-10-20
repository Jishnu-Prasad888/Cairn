import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fileFixture, json, mockApi, originalFetch, renderPage } from '../test/harness';
import DuplicatesPage from './DuplicatesPage';

const group = {
  content_hash: 'sha256-abcdef1234567890',
  size_bytes: 2048,
  files: [
    fileFixture({ content_hash: 'sha256-abcdef1234567890' }),
    fileFixture({
      id: 'f2',
      rel_path: '2024/IMG_0001_copy.png',
      name: 'IMG_0001_copy.png',
      folder_path: '2024',
      mod_time: '2026-09-02T00:00:00Z',
      content_hash: 'sha256-abcdef1234567890',
    }),
  ],
};

const duplicatesResponse = { groups: [group], next_cursor: '', total: 1 };

function setup(overrides: { duplicates?: unknown } = {}) {
  const payload = overrides.duplicates ?? duplicatesResponse;
  const fn = mockApi([(url) => (url.includes('/files/duplicates') ? json(payload) : undefined)]);
  renderPage(<DuplicatesPage />);
  return fn;
}

describe('DuplicatesPage', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('shows a heading and the library selector', async () => {
    setup();

    expect(await screen.findByRole('heading', { name: 'Duplicates' })).toBeInTheDocument();
    expect(await screen.findByTestId('library-picker')).toHaveValue('lib1');
  });

  it('renders duplicate groups with member files and sizes', async () => {
    setup();

    expect(await screen.findByText('IMG_0001.png')).toBeInTheDocument();
    expect(screen.getByText('IMG_0001_copy.png')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /2 identical files/ })).toBeInTheDocument();
    expect(screen.getByTestId('duplicates-summary')).toHaveTextContent('1 duplicate group');
  });

  it('keeps the newest copy and selects every other one', async () => {
    setup();

    await screen.findByText('IMG_0001.png');
    // IMG_0001_copy.png is the newer of the two, so it is the one kept.
    const [kept, other] = screen.getAllByTestId('dup-member');
    expect(within(kept!).getByText('IMG_0001_copy.png')).toBeInTheDocument();
    expect(within(kept!).getByText('Newest · kept')).toBeInTheDocument();
    expect(within(kept!).getByRole('checkbox')).not.toBeChecked();
    expect(within(other!).getByRole('checkbox')).toBeChecked();
    expect(screen.getByTestId('dup-trash-selected')).toHaveTextContent('Move 1 to trash');

    // The person can change their mind either way.
    fireEvent.click(within(kept!).getByRole('checkbox'));
    expect(screen.getByTestId('dup-trash-selected')).toHaveTextContent('Move 2 to trash');
    fireEvent.click(screen.getByRole('button', { name: 'Keep newest only' }));
    expect(screen.getByTestId('dup-trash-selected')).toHaveTextContent('Move 1 to trash');
  });

  it('links every member back to its download endpoint', async () => {
    setup();

    await screen.findByText('IMG_0001.png');
    const links = screen.getAllByRole('link', { name: 'Download' });
    expect(links.map((l) => l.getAttribute('href')).sort()).toEqual([
      '/api/v1/libraries/lib1/files/f1/download',
      '/api/v1/libraries/lib1/files/f2/download',
    ]);
  });

  it('moves the selected copies to the trash from the bar at the top', async () => {
    const fn = mockApi([
      (url, init) =>
        init?.method === 'DELETE' && url.includes('/files/f1')
          ? new Response(null, { status: 204 })
          : undefined,
      (url) => (url.includes('/files/duplicates') ? json(duplicatesResponse) : undefined),
    ]);
    renderPage(<DuplicatesPage />);

    await screen.findByText('IMG_0001.png');
    fireEvent.click(screen.getByTestId('dup-trash-selected'));
    await waitFor(() => {
      expect(
        fn.mock.calls.some(
          ([u, init]) => init?.method === 'DELETE' && String(u).includes('/files/f1'),
        ),
      ).toBe(true);
    });
    // Only the selected copy goes; the group then has nothing left to resolve.
    expect(
      fn.mock.calls.some(
        ([u, init]) => init?.method === 'DELETE' && String(u).includes('/files/f2'),
      ),
    ).toBe(false);
    await waitFor(() => {
      expect(screen.queryByText('IMG_0001.png')).not.toBeInTheDocument();
    });
  });

  it('moves a single file to the trash from its own button', async () => {
    const fn = mockApi([
      (url, init) =>
        init?.method === 'DELETE' && url.includes('/files/f2')
          ? new Response(null, { status: 204 })
          : undefined,
      (url) => (url.includes('/files/duplicates') ? json(duplicatesResponse) : undefined),
    ]);
    renderPage(<DuplicatesPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Move IMG_0001_copy.png to trash' }));
    await waitFor(() => {
      expect(
        fn.mock.calls.some(
          ([u, init]) => init?.method === 'DELETE' && String(u).includes('/files/f2'),
        ),
      ).toBe(true);
    });
  });

  it('shows the last result at once when coming back, without scanning again', async () => {
    const fn = setup();
    await screen.findByText('IMG_0001.png');
    const scans = () =>
      fn.mock.calls.filter(([u]) => String(u).includes('/files/duplicates')).length;
    expect(scans()).toBe(1);

    // Leave and come back: the page remounts.
    renderPage(<DuplicatesPage />);
    expect((await screen.findAllByText('IMG_0001.png')).length).toBeGreaterThan(0);
    expect(scans()).toBe(1);
  });

  it('shows an empty state when no duplicates exist', async () => {
    setup({ duplicates: { groups: [], next_cursor: '', total: 0 } });

    expect(await screen.findByTestId('duplicates-empty')).toBeInTheDocument();
    expect(screen.getByText('No duplicates')).toBeInTheDocument();
  });

  it('offers a rescan that re-requests the listing', async () => {
    const fetchMock = setup();

    await screen.findByText('IMG_0001.png');
    const before = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/files/duplicates'),
    ).length;

    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }));

    await waitFor(() => {
      const after = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/files/duplicates'),
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('asks for more groups only when the scan reports more than it returned', async () => {
    // The scan says there are 2 groups but the first page returned 1, so there
    // is more to load.
    const fn = mockApi([
      (url) =>
        url.includes('/files/duplicates') && url.includes('limit=100')
          ? json({
              groups: [group, { ...group, content_hash: 'sha256-second' }],
              next_cursor: '',
              total: 2,
            })
          : undefined,
      (url) =>
        url.includes('/files/duplicates')
          ? json({ groups: [group], next_cursor: 'c1', total: 2 })
          : undefined,
    ]);
    const view = renderPage(<DuplicatesPage />);

    const more = await within(view.container).findByRole('button', { name: 'Show more groups' });
    fireEvent.click(more);

    await waitFor(() => {
      expect(fn.mock.calls.some(([url]) => String(url).includes('limit=100'))).toBe(true);
    });
    await waitFor(() => {
      expect(view.container.querySelectorAll('.dup-group')).toHaveLength(2);
    });
  });

  it('explains when there are no libraries yet', async () => {
    mockApi([], { libraries: [] });
    renderPage(<DuplicatesPage />, { libraries: [] });

    expect(await screen.findByTestId('no-libraries')).toBeInTheDocument();
    expect(screen.queryByTestId('duplicates-summary')).not.toBeInTheDocument();
  });

  it('explains a failed scan instead of claiming there are none', async () => {
    mockApi([
      (url) =>
        url.includes('/files/duplicates')
          ? json({ error: { code: 'INTERNAL', message: 'Index is locked.', request_id: '1' } }, 500)
          : undefined,
    ]);
    renderPage(<DuplicatesPage />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Index is locked.');
    expect(screen.queryByTestId('duplicates-empty')).not.toBeInTheDocument();
  });

  it('warns when the library storage is offline', async () => {
    mockApi([(url) => (url.includes('/files/duplicates') ? json(duplicatesResponse) : undefined)], {
      libraries: [
        {
          id: 'lib1',
          name: 'Photos',
          root: '/srv/photos',
          status: 'offline',
          schema_version: 1,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
        },
      ],
    });
    renderPage(<DuplicatesPage />, {
      libraries: [
        {
          id: 'lib1',
          name: 'Photos',
          root: '/srv/photos',
          status: 'offline',
          schema_version: 1,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
        },
      ],
    });

    expect(await screen.findByTestId('library-offline')).toBeInTheDocument();
  });
});
