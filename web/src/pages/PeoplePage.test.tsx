import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PeoplePage from './PeoplePage';

const libraries = {
  libraries: [{ id: 'lib1', name: 'Photos', path: '/media' }],
};

const status = {
  enabled: true,
  provider: 'pigo_appearance',
  provider_version: 1,
  faces: 4,
  people: 2,
  unassigned: 2,
};

const people = {
  people: [
    { id: 'p1', name: 'Mom', cover_face_id: 'f1', cover_file_id: 'file1', face_count: 2 },
    { id: 'p2', name: 'Person 2', cover_face_id: '', cover_file_id: '', face_count: 0 },
  ],
};

const faces = {
  faces: [
    { id: 'f3', file_id: 'file3', x: 0, y: 0, width: 24, height: 24, confidence: 0.9 },
    { id: 'f4', file_id: 'file4', x: 0, y: 0, width: 24, height: 24, confidence: 0.7 },
  ],
};

const personDetail = {
  person: people.people[0],
  faces: [
    { id: 'f1', file_id: 'file1', x: 0, y: 0, width: 24, height: 24, confidence: 0.9 },
    { id: 'f2', file_id: 'file2', x: 0, y: 0, width: 24, height: 24, confidence: 0.8 },
  ],
};

function jsonResponse(status: number, body: unknown) {
  if (status === 204) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockApi({ disabled = false } = {}) {
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url.endsWith('/libraries')) {
      return jsonResponse(200, libraries);
    }
    if (/\/libraries\/lib1\/ml\/faces$/.test(url)) {
      return jsonResponse(200, status);
    }
    if (/\/libraries\/lib1\/people$/.test(url) && method === 'GET' && disabled) {
      return jsonResponse(503, {
        error: { code: 'SERVICE_UNAVAILABLE', message: 'disabled', request_id: '1' },
      });
    }
    if (/\/libraries\/lib1\/people$/.test(url) && method === 'GET') {
      return jsonResponse(200, people);
    }
    if (/\/libraries\/lib1\/people\/p1$/.test(url)) {
      return jsonResponse(200, personDetail);
    }
    if (/\/libraries\/lib1\/people\/p1\/rename$/.test(url)) {
      return jsonResponse(200, { renamed: true });
    }
    if (/\/libraries\/lib1\/people\/p1$/.test(url) && method === 'DELETE') {
      return jsonResponse(204, null);
    }
    if (/\/libraries\/lib1\/people\/p2\/faces\/f3$/.test(url)) {
      return jsonResponse(200, { assigned: true });
    }
    if (/\/libraries\/lib1\/faces$/.test(url)) {
      return jsonResponse(200, faces);
    }
    if (/\/libraries\/lib1\/ml\/faces\/pass$/.test(url)) {
      return jsonResponse(202, { status: 'started' });
    }
    if (/\/libraries\/lib1\/ml\/faces\/cluster$/.test(url)) {
      return jsonResponse(202, { status: 'started' });
    }
    if (/\/libraries\/lib1\/ml\/faces\/purge$/.test(url)) {
      return jsonResponse(200, { faces_removed: 4 });
    }
    if (/\/libraries\/lib1\/faces\/f[0-9]\/image$/.test(url)) {
      return jsonResponse(200, new Uint8Array());
    }
    return jsonResponse(404, { error: { code: 'X', message: 'missing', request_id: '1' } });
  });

  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function renderPage() {
  return render(
    <MemoryRouter>
      <PeoplePage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockApi();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PeoplePage', () => {
  it('renders people grid and stats', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText('Mom').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('Person 2').length).toBeGreaterThan(0);
    expect(screen.getByText(/4 faces · 2 people · 2 unassigned/)).toBeInTheDocument();
    // Unassigned pool is listed.
    waitFor(() => {
      expect(screen.getByLabelText('Unassigned faces')).toBeInTheDocument();
    });
  });

  it('expands a person to show their faces', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText('Mom').length).toBeGreaterThan(0);
    });
    const expand = screen.getAllByRole('button', { name: 'Faces' })[0]!;
    fireEvent.click(expand);
    await waitFor(() => {
      expect(screen.getByLabelText('Person faces')).toBeInTheDocument();
    });
  });

  it('starts a detection pass', async () => {
    const fetchMock = mockApi();
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText('Mom').length).toBeGreaterThan(0);
    });
    const detect = await screen.findByRole('button', { name: 'Detect faces' });
    fireEvent.click(detect);
    await waitFor(() => {
      const calls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => /\/ml\/faces\/pass$/.test(u));
      expect(calls.length).toBeGreaterThan(0);
    });
  });
});
