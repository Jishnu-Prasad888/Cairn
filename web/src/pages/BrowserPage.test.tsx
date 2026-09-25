import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import BrowserPage from './BrowserPage';

const libraries = {
  libraries: [{ id: 'lib1', name: 'Photos', path: '/srv/photos' }],
};

const folders = {
  folders: [{ id: 'dir1', rel_path: '2024', name: '2024', file_count: 2 }],
};

const files = {
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
  next_cursor: '',
  total: 2,
};

function renderPage(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.endsWith('/api/v1/libraries')) {
      return json(libraries);
    }
    if (url.includes('/files/upload')) {
      return json({ file: files.files[0] }, 201);
    }
    if (url.includes('/api/v1/libraries/lib1/trash')) {
      return json({ files: [] });
    }
    if (url.includes('/files/f1/note') || url.includes('/files/f2/note')) {
      const fileID = url.includes('/files/f1/note') ? 'f1' : 'f2';
      return json({ note: { file_id: fileID, body: '', updated_at: '' } });
    }
    if (url.includes('/search?q=')) {
      const q = url.split('q=')[1]?.split('&')[0] ?? '';
      return json({
        files: q === 'sunset' ? [files.files[0]] : [],
      });
    }
    if (url.includes('/favorites')) {
      return json({ files: [] });
    }
    if (url.includes('/files/f1/favorite') || url.includes('/files/f2/favorite')) {
      return empty(204);
    }
    if (url.includes('/files/f1/metadata')) {
      return json({
        metadata: {
          file_id: 'f1',
          media_type: 'photo',
          mime_type: 'image/png',
          width: 4032,
          height: 3024,
          camera_make: 'Apple',
          camera_model: 'iPhone 15',
          taken_at: '2026-06-01T12:00:00Z',
          latitude: 51.5074,
          longitude: -0.1278,
          has_thumbnail: true,
        },
      });
    }
    if (url.includes('/folders')) {
      return json(folders);
    }
    if (url.includes('/files')) {
      return json(files);
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

function err(status: number): Response {
  return new Response(
    JSON.stringify({
      error: { code: 'NOT_FOUND', message: 'missing', request_id: '1' },
    }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

function empty(status = 204): Response {
  return new Response(null, { status });
}

describe('BrowserPage', () => {
  it('renders the heading, folder cards, and a file grid', async () => {
    renderPage();
    render(
      <MemoryRouter>
        <BrowserPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Files' })).toBeInTheDocument();
    });
    expect(await screen.findByRole('button', { name: /2024/ })).toBeInTheDocument();
    expect(screen.getByTestId('file-grid')).toBeInTheDocument();
    expect(screen.getByText('IMG_0001.png')).toBeInTheDocument();
    expect(screen.getByText('clip.mp4')).toBeInTheDocument();
  });

  it('switches to the list view', async () => {
    renderPage();
    render(
      <MemoryRouter>
        <BrowserPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('file-grid')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(await screen.findByTestId('file-list')).toBeInTheDocument();
  });

  it('opens a photo viewer and closes it', async () => {
    renderPage();
    render(
      <MemoryRouter>
        <BrowserPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('IMG_0001.png')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('IMG_0001.png'));

    const viewer = await screen.findByTestId('viewer');
    const dialog = within(viewer).getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole('img')).toHaveAttribute(
      'src',
      '/api/v1/libraries/lib1/files/f1/thumbnail',
    );
    // Download link points at the streaming endpoint.
    expect(within(dialog).getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      '/api/v1/libraries/lib1/files/f1/download',
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close viewer' }));
    await waitFor(() => {
      expect(screen.queryByTestId('viewer')).not.toBeInTheDocument();
    });
  });

  it('opens a video viewer with inline playback', async () => {
    renderPage();
    render(
      <MemoryRouter>
        <BrowserPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('clip.mp4')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('clip.mp4'));

    await screen.findByRole('dialog');
    const video = screen.getByTestId('viewer').querySelector('video');
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('src', '/api/v1/libraries/lib1/files/f2/download');
  });

  it('edits a Markdown note under the image and autosaves it', async () => {
    const fetchMock = renderPage();
    render(
      <MemoryRouter>
        <BrowserPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('IMG_0001.png')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('IMG_0001.png'));

    const viewer = await screen.findByTestId('viewer');
    const note = within(viewer).getByTestId('viewer-note');

    // The note section sits below the image and starts in write mode.
    const textarea = within(note).getByLabelText('Markdown note');
    expect(textarea).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: '# Beach day\n\nSunset over the **dunes**.' } });

    // Preview renders the Markdown under the image.
    fireEvent.click(within(note).getByRole('button', { name: 'Preview' }));
    expect(within(note).getByRole('heading', { name: 'Beach day' })).toBeInTheDocument();
    expect(within(note).getByText('dunes')).toBeInTheDocument();

    // The debounced autosave PUTs the note to the server.
    await waitFor(
      () => {
        const putCall = fetchMock.mock.calls.find(
          ([input, init]) =>
            String(input).includes('/files/f1/note') && (init as RequestInit).method === 'PUT',
        );
        expect(putCall).toBeTruthy();
        const init = putCall?.[1] as RequestInit;
        expect(JSON.parse(String(init.body))).toMatchObject({
          body: '# Beach day\n\nSunset over the **dunes**.',
        });
      },
      { timeout: 3000 },
    );
  });

  it('toggles the favorite state and shows extracted metadata details', async () => {
    const fetchMock = renderPage();
    render(
      <MemoryRouter>
        <BrowserPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('IMG_0001.png')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('IMG_0001.png'));

    const viewer = await screen.findByTestId('viewer');
    const dialog = within(viewer).getByRole('dialog');

    // Details panel renders extracted metadata (dimensions, camera, map link).
    await within(dialog).findByTestId('viewer-details');
    expect(within(dialog).getByText('4032 × 3024px')).toBeInTheDocument();
    expect(within(dialog).getByText('Apple iPhone 15')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: '51.50740, -0.12780' })).toHaveAttribute(
      'href',
      expect.stringContaining('openstreetmap.org'),
    );
    expect(within(dialog).getByText('Camera')).toBeInTheDocument();

    // Favorites start empty, so the button reads "☆ Favorite".
    const favorite = within(dialog).getByRole('button', { name: '☆ Favorite' });
    expect(favorite).toBeEnabled();

    fireEvent.click(favorite);
    await within(dialog).findByRole('button', { name: '★ Favorited' });
    const postCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).includes('/files/f1/favorite') && (init as RequestInit).method === 'POST',
    );
    expect(postCall).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: '★ Favorited' }));
    await within(dialog).findByRole('button', { name: '☆ Favorite' });
    const deleteCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).includes('/files/f1/favorite') && (init as RequestInit).method === 'DELETE',
    );
    expect(deleteCall).toBeTruthy();
  });

  it('selects media and batch-favorites it from the selection bar', async () => {
    const fetchMock = renderPage();
    render(
      <MemoryRouter>
        <BrowserPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('IMG_0001.png')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Select IMG_0001.png' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select clip.mp4' }));

    const bar = await screen.findByTestId('selection-bar');
    expect(screen.getByTestId('selection-count')).toHaveTextContent('2 selected');

    fireEvent.click(within(bar).getByRole('button', { name: 'Favorite' }));

    await waitFor(() => {
      const f1 = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).endsWith('/files/f1/favorite') &&
          (init as RequestInit).method === 'POST',
      );
      expect(f1).toBeTruthy();
    });
    await waitFor(() => {
      const f2 = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).endsWith('/files/f2/favorite') &&
          (init as RequestInit).method === 'POST',
      );
      expect(f2).toBeTruthy();
    });

    // The selection clears after the batch action completes.
    await waitFor(() => {
      expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    });
  });

  it('uploads a file as multipart to the current folder', async () => {
    const fetchMock = renderPage();
    render(
      <MemoryRouter>
        <BrowserPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(document.querySelector('input[type="file"]')).not.toBeNull();
    });

    const input = document.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    const file = new File(['bytes'], 'beach.jpg', { type: 'image/jpeg' });
    Object.defineProperty(input!, 'files', { value: [file], configurable: true });
    input!.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() => {
      const upload = fetchMock.mock.calls.find(([input]) =>
        String(input).includes('/files/upload'),
      );
      expect(upload).toBeTruthy();
      expect(upload?.[1]?.body).toBeInstanceOf(FormData);
    });
    // The upload triggers a reload; wait for the refetch to settle inside act().
    await waitFor(() => {
      const folderCalls = fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/folders'),
      );
      expect(folderCalls).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.queryByText('Uploading…')).not.toBeInTheDocument();
    });
  });

  it('shows search results and an empty search state', async () => {
    renderPage();
    render(
      <MemoryRouter>
        <BrowserPage />
      </MemoryRouter>,
    );

    const search = (await screen.findByLabelText('Search files')) as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'sunset' } });

    await waitFor(() => {
      // Search replaces the folder listing with matching files.
      expect(screen.getByText('IMG_0001.png')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /2024/ })).not.toBeInTheDocument();
    });

    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(await screen.findByTestId('search-empty')).toBeInTheDocument();
  });

  it('shows an empty folder state', async () => {
    const fn = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith('/api/v1/libraries')) return json(libraries);
      if (url.includes('/folders')) return json({ folders: [] });
      if (url.includes('/files')) return json({ files: [], next_cursor: '', total: 0 });
      return err(404);
    }) as unknown as typeof fetch;
    globalThis.fetch = fn;

    render(
      <MemoryRouter>
        <BrowserPage />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('browser-empty')).toBeInTheDocument();
  });

  it('shows the trash panel on demand', async () => {
    renderPage();
    render(
      <MemoryRouter>
        <BrowserPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Trash' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Trash' }));
    expect(await screen.findByTestId('trash-panel')).toBeInTheDocument();
    // Wait for the trash listing to settle inside act().
    expect(await screen.findByText('Trash is empty.')).toBeInTheDocument();
  });
});
