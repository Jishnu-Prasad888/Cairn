import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MemoriesPage from './MemoriesPage';

const libraries = {
  libraries: [{ id: 'lib1', name: 'Photos', path: '/media' }],
};

const memory = {
  id: 'mem1',
  title: 'Trip to Rye',
  body: 'We saw **the pier** and [[album:a1|Rye]]!',
  deleted: false,
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-02T10:00:00Z',
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

function mockApi() {
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url.endsWith('/libraries')) {
      return jsonResponse(200, libraries);
    }
    if (/\/libraries\/lib1\/memories$/.test(url) && method === 'GET') {
      return jsonResponse(200, { memories: [memory] });
    }
    if (/\/libraries\/lib1\/memories\/mem1$/.test(url) && method === 'PUT') {
      return jsonResponse(200, { memory: { ...memory, updated_at: '2026-09-03T10:00:00Z' } });
    }
    if (/\/libraries\/lib1\/memories$/.test(url) && method === 'POST') {
      const created = JSON.parse(String(init?.body));
      return jsonResponse(201, {
        memory: { ...memory, id: 'mem2', title: created.title, body: created.body },
      });
    }
    if (/\/libraries\/lib1\/memories\/mem1\/versions$/.test(url)) {
      return jsonResponse(200, {
        versions: [
          {
            memory_id: 'mem1',
            version: 1,
            title: 'Trip to Rye',
            body: 'Draft one.',
            saved_at: '2026-09-01T10:00:00Z',
          },
        ],
      });
    }
    if (/\/libraries\/lib1\/memories\/mem1$/.test(url) && method === 'DELETE') {
      return jsonResponse(204, null);
    }
    return jsonResponse(404, { error: { code: 'X', message: 'missing', request_id: '1' } });
  });

  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  mockApi();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MemoriesPage', () => {
  it('loads libraries and lists memories', async () => {
    render(<MemoriesPage />);

    expect(await screen.findByText('Trip to Rye')).toBeInTheDocument();
    expect(screen.getByLabelText('Library')).toBeInTheDocument();
  });

  it('shows an empty state and creates a memory', async () => {
    // Override with an empty library.
    globalThis.fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/libraries')) {
        return jsonResponse(200, {
          libraries: [{ id: 'lib1', name: 'Photos', path: '/media' }],
        });
      }
      if (/\/libraries\/lib1\/memories$/.test(url) && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(200, { memories: [] });
      }
      if (/\/libraries\/lib1\/memories$/.test(url) && init?.method === 'POST') {
        return jsonResponse(201, {
          memory: {
            id: 'mem2',
            title: 'Untitled memory',
            body: '# New memory\n\nWrite something worth remembering…',
            deleted: false,
            created_at: '2026-09-01T10:00:00Z',
            updated_at: '2026-09-01T10:00:00Z',
          },
        });
      }
      return jsonResponse(404, { error: { code: 'X', message: 'missing', request_id: '1' } });
    }) as unknown as typeof fetch;

    render(<MemoriesPage />);
    await screen.findByText('No memories yet. Create your first one.');

    fireEvent.click(screen.getByRole('button', { name: 'New memory' }));

    expect(await screen.findByTestId('memory-editor')).toBeInTheDocument();
    expect(screen.getByLabelText('Memory title')).toHaveValue('Untitled memory');
  });

  it('opens the editor and renders a markdown preview', async () => {
    render(<MemoriesPage />);

    fireEvent.click(await screen.findByRole('button', { name: /Trip to Rye/ }));

    const editor = await screen.findByTestId('memory-editor');
    expect(editor).toBeInTheDocument();

    const preview = screen.getByLabelText('Markdown preview');
    expect(preview.innerHTML).toContain('<strong>the pier</strong>');
    expect(preview.innerHTML).toContain('md-ref md-ref-album');
  });

  it('autosaves on edit and reflects the save status', async () => {
    render(<MemoriesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Trip to Rye/ }));

    const body = await screen.findByLabelText('Memory body');
    fireEvent.change(body, { target: { value: 'Edited body with **changes**.' } });

    await waitFor(
      () => {
        expect(screen.getByText(/Saved/)).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('lists version history and restores a draft', async () => {
    render(<MemoriesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Trip to Rye/ }));

    const versionSelect = await screen.findByLabelText(/Restore an earlier version/);
    expect(versionSelect).toHaveTextContent('v1');

    fireEvent.change(versionSelect, { target: { value: '1' } });
    expect(screen.getByLabelText('Memory body')).toHaveValue('Draft one.');
  });

  it('deletes a memory after confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<MemoriesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Trip to Rye/ }));

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.queryByText('Trip to Rye')).not.toBeInTheDocument();
    });
    confirmSpy.mockRestore();
  });
});

describe('MemoryEditor ref toolbar', () => {
  it('inserts a reference template at the caret', async () => {
    render(<MemoriesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Trip to Rye/ }));

    const body = (await screen.findByLabelText('Memory body')) as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: 'See: ' } });
    body.focus();
    body.setSelectionRange(5, 5);

    fireEvent.click(screen.getByRole('button', { name: 'Album' }));

    expect(body.value).toBe('See: [[album:|]]');
  });
});
