import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  admin,
  bodyOf,
  called,
  fileFixture,
  json,
  member,
  mockApi,
  noContent,
  originalFetch,
  renderPage,
} from '../test/harness';
import type { RouteHandler } from '../test/harness';
import AlbumsPage from './AlbumsPage';

const albums = {
  albums: [
    {
      id: 'a1',
      name: 'Vacation',
      description: '',
      created_at: '2026-01-02T00:00:00Z',
      updated_at: '2026-01-05T00:00:00Z',
    },
  ],
};

const albumFiles = {
  files: [
    fileFixture(),
    fileFixture({
      id: 'f2',
      rel_path: 'clip.mp4',
      name: 'clip.mp4',
      size_bytes: 4194304,
      media_type: 'video',
      mime_type: 'video/mp4',
      content_hash: 'def',
    }),
  ],
};

const searchHit = {
  files: [fileFixture({ id: 'f3', rel_path: 'beach.jpg', name: 'beach.jpg', content_hash: 'ghi' })],
};

function setup(
  extraRules: RouteHandler[] = [],
  overrides: { albums?: typeof albums; albumFiles?: typeof albumFiles } = {},
) {
  const albumList = overrides.albums ?? albums;
  const files = overrides.albumFiles ?? albumFiles;
  const fn = mockApi([
    ...extraRules,
    (url, init) =>
      url.endsWith('/api/v1/libraries/lib1/albums/a1/files/f3') && init?.method === 'POST'
        ? noContent()
        : undefined, // add to album
    (url) => (url.endsWith('/api/v1/libraries/lib1/albums/a1/files') ? json(files) : undefined),
    (url, init) =>
      url.endsWith('/api/v1/libraries/lib1/albums/a1/files/f1') && init?.method === 'DELETE'
        ? noContent()
        : undefined, // remove from album
    (url, init) =>
      url.endsWith('/api/v1/libraries/lib1/albums/a1') && init?.method === 'DELETE'
        ? noContent()
        : undefined, // delete album
    (url, init) =>
      url.endsWith('/api/v1/libraries/lib1/albums') && init?.method === 'POST'
        ? json({ album: { id: 'a9', name: 'New' } }, 201)
        : undefined,
    (url) => (url.endsWith('/api/v1/libraries/lib1/albums') ? json(albumList) : undefined),
    (url) => (url.includes('/search?q=') ? json(searchHit) : undefined),
    // Browse-tab requests: folders + files listing
    (url) => (url.includes('/folders') ? json({ folders: [] }) : undefined),
    (url) =>
      url.includes('/files') &&
      !url.includes('/albums') &&
      !url.includes('/metadata') &&
      !url.includes('/note') &&
      !url.includes('/favorites')
        ? json({ files: [], total: 0 })
        : undefined,
    (url) =>
      url.includes('/files/f1/note') ? json({ note: { file_id: 'f1', body: '' } }) : undefined,
    (url) => (url.includes('/favorites') ? json({ files: [] }) : undefined),
    (url) =>
      url.includes('/files/f1/metadata')
        ? json({
            metadata: {
              file_id: 'f1',
              media_type: 'photo',
              mime_type: 'image/jpeg',
              width: 4032,
              height: 3024,
              camera_make: 'Apple',
              camera_model: 'iPhone 15',
              taken_at: '2026-06-01T12:00:00Z',
              has_thumbnail: true,
            },
          })
        : undefined,
  ]);
  renderPage(<AlbumsPage />);
  return fn;
}

describe('AlbumsPage', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('renders the heading and album cards', async () => {
    setup();

    expect(await screen.findByRole('heading', { name: 'Albums' })).toBeInTheDocument();
    expect(await screen.findByTestId('albums-grid')).toBeInTheDocument();
    expect(screen.getByText('Vacation')).toBeInTheDocument();
  });

  it('shows an empty state when there are no albums', async () => {
    setup([], { albums: { albums: [] } });

    expect(await screen.findByTestId('albums-empty')).toBeInTheDocument();
  });

  it('creates an album from the dialog', async () => {
    const fetchMock = setup();
    const promptSpy = vi.spyOn(window, 'prompt');

    await screen.findByTestId('albums-grid');
    fireEvent.click(screen.getByRole('button', { name: 'New album' }));

    const dialog = await screen.findByTestId('new-album-dialog');
    fireEvent.change(screen.getByLabelText('Album name'), { target: { value: 'Noon' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(called(fetchMock, 'POST', '/api/v1/libraries/lib1/albums')).toBe(true);
    });
    expect(bodyOf(fetchMock, 'POST', '/api/v1/libraries/lib1/albums')).toEqual({ name: 'Noon' });
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('opens an album and lists its files', async () => {
    setup();

    await screen.findByTestId('albums-grid');
    fireEvent.click(screen.getAllByRole('button', { name: /Vacation/ })[0]!);

    expect(await screen.findByTestId('album-detail')).toBeInTheDocument();
    expect(screen.getByTestId('file-grid')).toBeInTheDocument();
    expect(screen.getByText('IMG_0001.png')).toBeInTheDocument();
    expect(screen.getByText('clip.mp4')).toBeInTheDocument();
  });

  it('shows a timeline scoped to the album when its photos span more than one month', async () => {
    setup([], {
      albumFiles: {
        files: [
          fileFixture({ mod_time: '2026-09-01T00:00:00Z' }),
          fileFixture({
            id: 'f2',
            rel_path: 'july.png',
            name: 'july.png',
            mod_time: '2026-07-01T00:00:00Z',
          }),
        ],
      },
    });

    await screen.findByTestId('albums-grid');
    fireEvent.click(screen.getAllByRole('button', { name: /Vacation/ })[0]!);

    await screen.findByTestId('album-detail');
    expect(screen.queryByTestId('timeline')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('toggle-timeline'));

    expect(await screen.findByTestId('timeline')).toBeInTheDocument();
  });

  it('returns to the album list from the detail view', async () => {
    setup();

    await screen.findByTestId('albums-grid');
    fireEvent.click(screen.getAllByRole('button', { name: /Vacation/ })[0]!);
    await screen.findByTestId('album-detail');

    fireEvent.click(screen.getByRole('button', { name: 'Back to albums' }));

    expect(await screen.findByTestId('albums-grid')).toBeInTheDocument();
  });

  it('removes a file from the album', async () => {
    const fetchMock = setup();

    await screen.findByTestId('albums-grid');
    fireEvent.click(screen.getAllByRole('button', { name: /Vacation/ })[0]!);
    await screen.findByTestId('file-grid');

    // Photos are removed through the selection bar; the album itself is untouched.
    fireEvent.click(screen.getByRole('button', { name: 'Select IMG_0001.png' }));
    fireEvent.click(await screen.findByTestId('selection-remove'));

    await waitFor(() => {
      expect(called(fetchMock, 'DELETE', '/api/v1/libraries/lib1/albums/a1/files/f1')).toBe(true);
    });
  });

  it('deletes an album after confirming the dialog', async () => {
    const fetchMock = setup();
    const confirmSpy = vi.spyOn(window, 'confirm');

    await screen.findByTestId('albums-grid');
    fireEvent.click(screen.getAllByRole('button', { name: /Vacation/ })[0]!);
    await screen.findByTestId('album-detail');

    fireEvent.click(screen.getByRole('button', { name: 'Album options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete album' }));
    const dialog = await screen.findByTestId('delete-album-dialog');
    expect(dialog).toHaveAttribute('role', 'dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete album' }));

    await waitFor(() => {
      expect(called(fetchMock, 'DELETE', '/api/v1/libraries/lib1/albums/a1')).toBe(true);
    });
    // Back on the album list after deletion.
    expect(await screen.findByTestId('albums-grid')).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('renames an album from its options menu', async () => {
    const fetchMock = setup([
      (url, init) =>
        url.endsWith('/api/v1/libraries/lib1/albums/a1') && init?.method === 'PATCH'
          ? json({ album: { ...albums.albums[0], name: 'Summer 2026' } })
          : undefined,
    ]);

    await screen.findByTestId('albums-grid');
    fireEvent.click(screen.getAllByRole('button', { name: /Vacation/ })[0]!);
    await screen.findByTestId('album-detail');

    fireEvent.click(screen.getByRole('button', { name: 'Album options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename album' }));
    const dialog = await screen.findByTestId('rename-album-dialog');
    fireEvent.change(within(dialog).getByLabelText('Album name'), {
      target: { value: 'Summer 2026' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(bodyOf(fetchMock, 'PATCH', '/api/v1/libraries/lib1/albums/a1')).toEqual({
        name: 'Summer 2026',
      });
    });
  });

  it('uses a selected photo as the album cover', async () => {
    const fetchMock = setup([
      (url, init) =>
        url.endsWith('/api/v1/libraries/lib1/albums/a1') && init?.method === 'PATCH'
          ? json({ album: albums.albums[0] })
          : undefined,
    ]);

    await screen.findByTestId('albums-grid');
    fireEvent.click(screen.getAllByRole('button', { name: /Vacation/ })[0]!);
    await screen.findByTestId('file-grid');

    fireEvent.click(screen.getByRole('button', { name: 'Select clip.mp4' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use as album cover' }));

    await waitFor(() => {
      expect(bodyOf(fetchMock, 'PATCH', '/api/v1/libraries/lib1/albums/a1')).toEqual({
        cover_file_id: 'f2',
      });
    });
  });

  it('keeps the album when the delete dialog is cancelled', async () => {
    const fetchMock = setup();

    await screen.findByTestId('albums-grid');
    fireEvent.click(screen.getAllByRole('button', { name: /Vacation/ })[0]!);
    await screen.findByTestId('album-detail');

    fireEvent.click(screen.getByRole('button', { name: 'Album options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete album' }));
    const dialog = await screen.findByTestId('delete-album-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByTestId('delete-album-dialog')).not.toBeInTheDocument();
    });
    expect(called(fetchMock, 'DELETE', '/albums/a1')).toBe(false);
    expect(screen.getByTestId('album-detail')).toBeInTheDocument();
  });

  it('adds files to an album from the picker', async () => {
    const fetchMock = setup();

    await screen.findByTestId('albums-grid');
    fireEvent.click(screen.getAllByRole('button', { name: /Vacation/ })[0]!);
    await screen.findByTestId('file-grid');

    fireEvent.click(screen.getByTestId('add-files-button'));
    const dialog = await screen.findByTestId('add-files-dialog');

    // Switch to the search tab
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Search' }));

    const search = screen.getByLabelText('Search library files') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'beach' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Search' }));

    // Nothing ticked yet, so there is nothing to add.
    expect(within(dialog).getByTestId('confirm-add-files')).toBeDisabled();

    const checkbox = await screen.findByRole('checkbox', { name: 'Select beach.jpg' });
    fireEvent.click(checkbox);
    expect(within(dialog).getByTestId('confirm-add-files')).toBeEnabled();
    expect(within(dialog).getByTestId('confirm-add-files')).toHaveTextContent('Add 1');
    fireEvent.click(within(dialog).getByTestId('confirm-add-files'));

    await waitFor(() => {
      expect(called(fetchMock, 'POST', '/api/v1/libraries/lib1/albums/a1/files/f3')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('add-files-dialog')).not.toBeInTheDocument();
    });
  });

  it('disables the files already in the album in the picker', async () => {
    setup();

    await screen.findByTestId('albums-grid');
    fireEvent.click(screen.getAllByRole('button', { name: /Vacation/ })[0]!);
    await screen.findByTestId('file-grid');

    fireEvent.click(screen.getByTestId('add-files-button'));
    const dialog = await screen.findByTestId('add-files-dialog');

    // Switch to the search tab
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Search' }));

    fireEvent.change(screen.getByLabelText('Search library files'), { target: { value: 'beach' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Search' }));

    // The search returns a file that is not in the album, so it is selectable,
    // and the dialog says so rather than silently hiding it.
    await screen.findByRole('checkbox', { name: 'Select beach.jpg' });
    expect(screen.getByTestId('confirm-add-files')).toBeDisabled();
  });

  it('reports a failed search inside the picker', async () => {
    mockApi([
      (url) =>
        url.includes('/search?q=nothing')
          ? json(
              {
                error: { code: 'BAD_REQUEST', message: 'Search is not indexed.', request_id: '1' },
              },
              400,
            )
          : undefined,
      (url) => (url.endsWith('/api/v1/libraries/lib1/albums') ? json(albums) : undefined),
      (url) =>
        url.endsWith('/api/v1/libraries/lib1/albums/a1/files') ? json(albumFiles) : undefined,
      (url) => (url.includes('/folders') ? json({ folders: [] }) : undefined),
      (url) =>
        url.includes('/files') && !url.includes('/albums')
          ? json({ files: [], total: 0 })
          : undefined,
    ]);
    renderPage(<AlbumsPage />);

    await screen.findByTestId('albums-grid');
    fireEvent.click(screen.getAllByRole('button', { name: /Vacation/ })[0]!);
    await screen.findByTestId('file-grid');

    fireEvent.click(screen.getByTestId('add-files-button'));
    const dialog = await screen.findByTestId('add-files-dialog');

    // Switch to the search tab
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Search' }));

    fireEvent.change(screen.getByLabelText('Search library files'), {
      target: { value: 'nothing' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Search' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Search is not indexed.');
  });

  it('renames an album from the grid card’s own menu, without opening it', async () => {
    const fetchMock = setup([
      (url, init) =>
        url.endsWith('/api/v1/libraries/lib1/albums/a1') && init?.method === 'PATCH'
          ? json({ album: { ...albums.albums[0], name: 'Summer 2026' } })
          : undefined,
    ]);

    await screen.findByTestId('albums-grid');
    fireEvent.click(screen.getByTestId('album-menu-a1'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename album' }));

    const dialog = await screen.findByTestId('rename-album-dialog');
    fireEvent.change(within(dialog).getByLabelText('Album name'), {
      target: { value: 'Summer 2026' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(bodyOf(fetchMock, 'PATCH', '/api/v1/libraries/lib1/albums/a1')).toEqual({
        name: 'Summer 2026',
      });
    });
    // Still on the grid — renaming from the card never opened the album.
    expect(await screen.findByTestId('albums-grid')).toBeInTheDocument();
  });

  it('deletes an album from the grid card’s own menu', async () => {
    const fetchMock = setup();

    await screen.findByTestId('albums-grid');
    fireEvent.click(screen.getByTestId('album-menu-a1'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete album' }));

    const dialog = await screen.findByTestId('delete-album-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete album' }));

    await waitFor(() => {
      expect(called(fetchMock, 'DELETE', '/api/v1/libraries/lib1/albums/a1')).toBe(true);
    });
  });

  it('opens the same card menu with a right-click', async () => {
    setup();

    await screen.findByTestId('albums-grid');
    fireEvent.contextMenu(screen.getAllByRole('button', { name: /Vacation/ })[0]!);

    expect(await screen.findByRole('menuitem', { name: 'Rename album' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Share album' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete album' })).toBeInTheDocument();
  });
});

describe('AlbumShareDialog', () => {
  const grant: RouteHandler = (url, init) =>
    url.endsWith('/api/v1/libraries/lib1/permissions') && !init?.method
      ? json({
          grants: [
            {
              id: 'g1',
              user_id: 'u2',
              resource_key: 'lib1/a:a1',
              capabilities: ['read'],
              effect: 'allow',
              created_at: '2026-01-01T00:00:00Z',
            },
          ],
        })
      : undefined;
  const noShares: RouteHandler = (url, init) =>
    url.endsWith('/api/v1/libraries/lib1/shares') && !init?.method
      ? json({ shares: [] })
      : undefined;
  const activeShare: RouteHandler = (url, init) =>
    url.endsWith('/api/v1/libraries/lib1/shares') && !init?.method
      ? json({
          shares: [
            {
              id: 's1',
              resource_key: 'lib1/a:a1',
              capabilities: ['read'],
              has_password: false,
              created_at: '2026-01-01T00:00:00Z',
            },
          ],
        })
      : undefined;
  const other = {
    id: 'u3',
    username: 'bob',
    role: 'user' as const,
    created_at: '2026-03-03T00:00:00Z',
  };
  const users: RouteHandler = (url) =>
    url.endsWith('/api/v1/users') ? json({ users: [admin, member, other] }) : undefined;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function openShareDialog(extra: RouteHandler[]) {
    const fetchMock = setup(extra);
    await screen.findByTestId('albums-grid');
    fireEvent.click(screen.getByTestId('album-menu-a1'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Share album' }));
    const dialog = await screen.findByTestId('album-share-dialog');
    return { fetchMock, dialog };
  }

  it('lists people who already have access, by name', async () => {
    const { dialog } = await openShareDialog([grant, noShares, users]);

    const people = within(dialog).getByTestId('album-share-people');
    expect(within(people).getByText('alice')).toBeInTheDocument();
    expect(within(people).getByText('Can view')).toBeInTheDocument();
  });

  it('grants a person edit access on the album’s own resource key', async () => {
    const { fetchMock, dialog } = await openShareDialog([
      grant,
      noShares,
      users,
      (url, init) =>
        url.endsWith('/api/v1/libraries/lib1/permissions') && init?.method === 'POST'
          ? json({ grant: { id: 'g2' } }, 201)
          : undefined,
    ]);

    fireEvent.change(within(dialog).getByTestId('album-share-user'), {
      target: { value: 'u3' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Can edit' }));
    fireEvent.click(within(dialog).getByTestId('confirm-album-share'));

    await waitFor(() => {
      expect(bodyOf(fetchMock, 'POST', '/api/v1/libraries/lib1/permissions')).toEqual({
        user_id: 'u3',
        key: 'lib1/a:a1',
        caps: ['read', 'download', 'edit'],
        effect: 'allow',
      });
    });
  });

  it('removes a person’s access', async () => {
    const { fetchMock, dialog } = await openShareDialog([
      grant,
      noShares,
      users,
      (url, init) =>
        url.endsWith('/api/v1/libraries/lib1/permissions/g1') && init?.method === 'DELETE'
          ? noContent()
          : undefined,
    ]);

    fireEvent.click(within(dialog).getByTestId('revoke-album-grant-g1'));

    await waitFor(() => {
      expect(called(fetchMock, 'DELETE', '/api/v1/libraries/lib1/permissions/g1')).toBe(true);
    });
  });

  it('makes an album public and shows the link exactly once', async () => {
    const { fetchMock, dialog } = await openShareDialog([
      grant,
      noShares,
      users,
      (url, init) =>
        url.endsWith('/api/v1/libraries/lib1/shares') && init?.method === 'POST'
          ? json(
              {
                share: {
                  id: 's1',
                  resource_key: 'lib1/a:a1',
                  capabilities: ['read'],
                  has_password: false,
                  created_at: '2026-01-01T00:00:00Z',
                },
                token: 'tok123',
              },
              201,
            )
          : undefined,
    ]);

    fireEvent.click(within(dialog).getByTestId('make-album-public'));

    await waitFor(() => {
      expect(bodyOf(fetchMock, 'POST', '/api/v1/libraries/lib1/shares')).toEqual({
        key: 'lib1/a:a1',
        caps: ['read', 'download'],
      });
    });
    expect(await within(dialog).findByTestId('album-public-url')).toHaveValue(
      `${window.location.origin}/s/tok123`,
    );
  });

  it('turns off an existing public link', async () => {
    const { fetchMock, dialog } = await openShareDialog([
      grant,
      activeShare,
      users,
      (url, init) =>
        url.endsWith('/api/v1/libraries/lib1/shares/s1') && init?.method === 'DELETE'
          ? noContent()
          : undefined,
    ]);

    expect(await within(dialog).findByTestId('turn-off-album-public')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByTestId('turn-off-album-public'));

    await waitFor(() => {
      expect(called(fetchMock, 'DELETE', '/api/v1/libraries/lib1/shares/s1')).toBe(true);
    });
  });
});
