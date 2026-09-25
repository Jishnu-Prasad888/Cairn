import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import TagsPage from './TagsPage';

const libraries = {
  libraries: [{ id: 'lib1', name: 'Photos', path: '/srv/photos' }],
};

const tags = {
  tags: [
    {
      id: 't1',
      name: 'vacation',
      created_at: '2026-01-02T00:00:00Z',
    },
  ],
};

const tagFiles = {
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
  ],
};

function renderPage(overrides: { tags?: typeof tags; tagFiles?: typeof tagFiles } = {}) {
  const tagList = overrides.tags ?? tags;
  const files = overrides.tagFiles ?? tagFiles;
  const fn = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/v1/libraries')) {
      return json(libraries);
    }
    if (url.includes('/api/v1/libraries/lib1/files/f1/tags/t1')) {
      return empty(204); // remove tag from file
    }
    if (url.includes('/api/v1/libraries/lib1/tags/t1')) {
      return empty(204); // delete tag
    }
    if (url.endsWith('/api/v1/libraries/lib1/tags')) {
      if (init?.method === 'POST') return json({ tag: { id: 't9', name: 'Trip' } }, 201);
      return json(tagList);
    }
    if (url.includes('/search?tag=')) {
      const name = url.split('tag=')[1]?.split('&')[0] ?? '';
      return json(name === 'vacation' ? files : { files: [] });
    }
    if (url.includes('/files/f1/note')) {
      return json({ note: { file_id: 'f1', body: '', updated_at: '' } });
    }
    if (url.includes('/favorites')) {
      return json({ files: [] });
    }
    if (url.includes('/files/f1/metadata')) {
      return json({
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
      });
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
      <TagsPage />
    </MemoryRouter>,
  );
}

describe('TagsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the heading and tag cards', async () => {
    renderPage();
    setup();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Tags' })).toBeInTheDocument();
    });
    expect(await screen.findByTestId('tags-grid')).toBeInTheDocument();
    expect(screen.getByText('vacation')).toBeInTheDocument();
  });

  it('shows an empty state when there are no tags', async () => {
    renderPage({ tags: { tags: [] } });
    setup();

    expect(await screen.findByTestId('tags-empty')).toBeInTheDocument();
  });

  it('creates a tag from a prompt', async () => {
    const fetchMock = renderPage();
    vi.spyOn(window, 'prompt').mockReturnValue('Trip');
    setup();

    await screen.findByTestId('tags-grid');
    fireEvent.click(screen.getByRole('button', { name: 'New tag' }));

    await waitFor(() => {
      const create = fetchMock.mock.calls.find(([input, init]) => {
        const u = String(input);
        return u.endsWith('/api/v1/libraries/lib1/tags') && init?.method === 'POST';
      });
      expect(create).toBeTruthy();
      expect(JSON.parse(String(create?.[1]?.body))).toEqual({ name: 'Trip' });
    });
  });

  it('opens a tag and lists its files', async () => {
    renderPage();
    setup();

    await screen.findByTestId('tags-grid');
    fireEvent.click(screen.getByRole('button', { name: /vacation/ }));

    expect(await screen.findByTestId('tag-detail')).toBeInTheDocument();
    expect(screen.getByTestId('file-grid')).toBeInTheDocument();
    expect(screen.getByText('IMG_0001.png')).toBeInTheDocument();
  });

  it('removes a tag from a file shown under that tag', async () => {
    const fetchMock = renderPage();
    setup();

    await screen.findByTestId('tags-grid');
    fireEvent.click(screen.getByRole('button', { name: /vacation/ }));
    await screen.findByTestId('file-grid');

    fireEvent.click(screen.getByRole('button', { name: 'Remove tag vacation from IMG_0001.png' }));

    await waitFor(() => {
      const remove = fetchMock.mock.calls.find(([input, init]) => {
        const u = String(input);
        return u.endsWith('/api/v1/libraries/lib1/files/f1/tags/t1') && init?.method === 'DELETE';
      });
      expect(remove).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.queryByText('IMG_0001.png')).not.toBeInTheDocument();
    });
  });

  it('deletes a tag after confirmation', async () => {
    const fetchMock = renderPage();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    setup();

    await screen.findByTestId('tags-grid');
    fireEvent.click(screen.getByRole('button', { name: /vacation/ }));
    await screen.findByTestId('tag-detail');

    fireEvent.click(screen.getByRole('button', { name: 'Delete tag' }));

    await waitFor(() => {
      const del = fetchMock.mock.calls.find(([input, init]) => {
        const u = String(input);
        return u.endsWith('/api/v1/libraries/lib1/tags/t1') && init?.method === 'DELETE';
      });
      expect(del).toBeTruthy();
    });
    // Back on the tag list after deletion.
    expect(await screen.findByTestId('tags-grid')).toBeInTheDocument();
  });
});
