import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AlbumsPage from './AlbumsPage';

const libraries = {
  libraries: [{ id: 'lib1', name: 'Photos', path: '/srv/photos' }],
};

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
    {
      id: 'f1',
      library_id: 'lib1',
      rel_path: 'IMG_0001.png',
      name: 'IMG_0001.png',
      folder_path: '',
      size_bytes: 2048,
      mod_time: '2026-09-01T00:00:00Z',
      media_type: 'photo',
      mime_type: 'image/png',
      status: 'present',
      content_hash: 'abc',
    },
    {
      id: 'f2',
      library_id: 'lib1',
      rel_path: 'clip.mp4',
      name: 'clip.mp4',
      folder_path: '',
      size_bytes: 4194304,
      mod_time: '2026-09-01T00:00:00Z',
      media_type: 'video',
      mime_type: 'video/mp4',
      status: 'present',
      content_hash: 'def',
    },
  ],
};

const searchHit = {
  files: [
    {
      id: 'f3',
      library_id: 'lib1',
      rel_path: 'beach.jpg',
      name: 'beach.jpg',
      folder_path: '',
      size_bytes: 4096,
      mod_time: '2026-09-01T00:00:00Z',
      media_type: 'photo',
      mime_type: 'image/jpeg',
      status: 'present',
      content_hash: 'ghi',
    },
  ],
};

function renderPage(overrides: { albums?: typeof albums; albumFiles?: typeof albumFiles } = {}) {
  const albumList = overrides.albums ?? albums;
  const files = overrides.albumFiles ?? albumFiles;
  const fn = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/v1/libraries')) {
      return json(libraries);
    }
    if (url.includes('/api/v1/libraries/lib1/albums/a1/files')) {
      return json(files);
    }
    if (url.includes('/api/v1/libraries/lib1/albums/a1/files/f1')) {
      return empty(204); // remove.from album
    }
    if (url.includes('/api/v1/libraries/lib1/albums/a1')) {
      if (init?.method === 'DELETE') return empty(204); // delete album
      return json({ albums: [] });
    }
    if (url.includes('/api/v1/libraries/lib1/albums')) {
      if (init?.method === 'POST') return json({ album: { id: 'a9', name: 'New' } }, 201);
      return json(albumList);
    }
    if (url.includes('/search?q=')) {
      return json(searchHit.files.length > 0 ? searchHit : { files: [] });
    }
    return err(404);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function empty(status: number): Response {
  return new Response(null, { status });
}

function err(status: number): Response {
  return new Response(
    JSON.stringify({
      error: { code: 'NOT_FOUND', message: 'missing', request_id: '1' },
    }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

function setup() {
  return render(
    <MemoryRouter>
      <AlbumsPage />
    </MemoryRouter>,
  );
}

describe('AlbumsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the heading and album cards', async () => {
    renderPage();
    setup();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Albums' })).toBeInTheDocument();
    });
    expect(await screen.findByTestId('albums-grid')).toBeInTheDocument();
    expect(screen.getByText('Vacation')).toBeInTheDocument();
  });

  it('shows an empty state when there are no albums', async () => {
    renderPage({ albums: { albums: [] } });
    setup();

    expect(await screen.findByTestId('albums-empty')).toBeInTheDocument();
  });

  it('creates an album from a prompt', async () => {
    const fetchMock = renderPage();
    vi.spyOn(window, 'prompt').mockReturnValue('Noon');
    setup();

    await screen.findByTestId('albums-grid');
    fireEvent.click(screen.getByRole('button', { name: 'New album' }));

    await waitFor(() => {
      const create = fetchMock.mock.calls.find(([input, init]) => {
        const u = String(input);
        return u.endsWith('/api/v1/libraries/lib1/albums') && init?.method === 'POST';
      });
      expect(create).toBeTruthy();
      expect(JSON.parse(String(create?.[1]?.body))).toEqual({ name: 'Noon' });
    });
  });

  it('opens an album and lists its files', async () => {
    renderPage();
    setup();

    await screen.findByTestId('albums-grid');
    fireEvent.click(screen.getByRole('button', { name: /Vacation/ }));

    expect(await screen.findByTestId('album-detail')).toBeInTheDocument();
    expect(screen.getByTestId('file-grid')).toBeInTheDocument();
    expect(screen.getByText('IMG_0001.png')).toBeInTheDocument();
    expect(screen.getByText('clip.mp4')).toBeInTheDocument();
  });

  it('removes a file from the album', async () => {
    const fetchMock = renderPage();
    setup();

    await screen.findByTestId('albums-grid');
    fireEvent.click(screen.getByRole('button', { name: /Vacation/ }));
    await screen.findByTestId('file-grid');

    fireEvent.click(screen.getByRole('button', { name: 'Remove IMG_0001.png from album' }));

    await waitFor(() => {
      const remove = fetchMock.mock.calls.find(([input, init]) => {
        const u = String(input);
        return u.endsWith('/api/v1/libraries/lib1/albums/a1/files/f1') && init?.method === 'DELETE';
      });
      expect(remove).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.queryByText('IMG_0001.png')).not.toBeInTheDocument();
    });
  });

  it('deletes an album after confirmation', async () => {
    const fetchMock = renderPage();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    setup();

    await screen.findByTestId('albums-grid');
    fireEvent.click(screen.getByRole('button', { name: /Vacation/ }));
    await screen.findByTestId('album-detail');

    fireEvent.click(screen.getByRole('button', { name: 'Delete album' }));

    await waitFor(() => {
      const del = fetchMock.mock.calls.find(([input, init]) => {
        const u = String(input);
        return u.endsWith('/api/v1/libraries/lib1/albums/a1') && init?.method === 'DELETE';
      });
      expect(del).toBeTruthy();
    });
    // Back on the album list after deletion.
    expect(await screen.findByTestId('albums-grid')).toBeInTheDocument();
  });

  it('adds files to an album from the picker', async () => {
    const fetchMock = renderPage();
    setup();

    await screen.findByTestId('albums-grid');
    fireEvent.click(screen.getByRole('button', { name: /Vacation/ }));
    await screen.findByTestId('file-grid');

    fireEvent.click(screen.getByRole('button', { name: 'Add files' }));
    const search = screen.getByLabelText('Search files to add') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'beach' } });

    const checkbox = await screen.findByRole('checkbox', { name: 'Select beach.jpg' });
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: /Add selected \(1\)/ }));

    await waitFor(() => {
      const add = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).endsWith('/api/v1/libraries/lib1/albums/a1/files/f3') &&
          init?.method === 'POST',
      );
      expect(add).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.queryByTestId('album-picker')).not.toBeInTheDocument();
    });
  });
});
