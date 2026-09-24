import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import DuplicatesPage from './DuplicatesPage';

const libraries = {
  libraries: [{ id: 'lib1', name: 'Photos', path: '/srv/photos' }],
};

const duplicatesResponse = {
  groups: [
    {
      content_hash: 'sha256-abcdef1234567890',
      size_bytes: 2048,
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
          content_hash: 'sha256-abcdef1234567890',
        },
        {
          id: 'f2',
          library_id: 'lib1',
          rel_path: '2024/IMG_0001_copy.png',
          name: 'IMG_0001_copy.png',
          folder_path: '2024',
          size_bytes: 2048,
          mod_time: '2026-09-02T00:00:00Z',
          media_type: 'photo',
          mime_type: 'image/png',
          status: 'present',
          content_hash: 'sha256-abcdef1234567890',
        },
      ],
    },
  ],
  next_cursor: '',
  total: 1,
};

function renderPage() {
  return render(
    <MemoryRouter>
      <DuplicatesPage />
    </MemoryRouter>,
  );
}

function mockApiResponder(duplicates: unknown) {
  const fn = vi.fn(async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.endsWith('/api/v1/libraries')) {
      return new Response(JSON.stringify(libraries), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/files/duplicates')) {
      return new Response(JSON.stringify(duplicates), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      '{ "error": { "code": "NOT_FOUND", "message": "missing", "request_id": "1" } }',
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('DuplicatesPage', () => {
  it('shows a heading and the library selector', async () => {
    mockApiResponder(duplicatesResponse);
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Duplicates' })).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Library')).toHaveValue('lib1');
  });

  it('renders duplicate groups with member files and sizes', async () => {
    mockApiResponder(duplicatesResponse);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('IMG_0001.png')).toBeInTheDocument();
    });
    expect(screen.getByText('IMG_0001_copy.png')).toBeInTheDocument();
    expect(screen.getByText(/2 identical files/)).toBeInTheDocument();
    expect(screen.getByText(/1 duplicate group/)).toBeInTheDocument();
    // Each member gets a download link back to the API.
    const links = screen.getAllByRole('link', { name: 'Download' });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', '/api/v1/libraries/lib1/files/f1/download');
  });

  it('shows an empty state when no duplicates exist', async () => {
    mockApiResponder({ groups: [], next_cursor: '', total: 0 });
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('duplicates-empty')).toBeInTheDocument();
    });
    expect(screen.getByText(/No duplicates found/)).toBeInTheDocument();
  });

  it('explains when there are no libraries yet', async () => {
    const fn = vi.fn(
      async () =>
        new Response(JSON.stringify({ libraries: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fn;

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/No libraries yet/)).toBeInTheDocument();
    });
  });
});
