import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { called, json, mockApi, noContent, originalFetch, renderPage } from '../test/harness';
import MemoriesPage from './MemoriesPage';

const memory = {
  id: 'mem1',
  title: 'Trip to Rye',
  body: 'We saw **the pier** and [[album:a1|Rye]]!',
  deleted: false,
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-02T10:00:00Z',
};

const versions = {
  versions: [
    {
      memory_id: 'mem1',
      version: 1,
      title: 'Trip to Rye',
      body: 'Draft one.',
      saved_at: '2026-09-01T10:00:00Z',
    },
  ],
};

function setup(overrides: { memories?: unknown[] } = {}) {
  const list = overrides.memories ?? [memory];
  const fn = mockApi([
    (url, init) =>
      /\/libraries\/lib1\/memories\/mem1$/.test(url) && init?.method === 'PUT'
        ? json({ memory: { ...memory, updated_at: '2026-09-03T10:00:00Z' } })
        : undefined,
    (url, init) =>
      /\/libraries\/lib1\/memories$/.test(url) && init?.method === 'POST'
        ? json(
            {
              memory: {
                ...memory,
                id: 'mem2',
                title: 'Untitled memory',
                body: '# New memory\n\nWrite something worth remembering…',
              },
            },
            201,
          )
        : undefined,
    (url) => (/\/memories\/mem1\/versions$/.test(url) ? json(versions) : undefined),
    (url, init) =>
      /\/memories\/mem1$/.test(url) && init?.method === 'DELETE' ? noContent() : undefined,
    (url) => (/\/libraries\/lib1\/memories$/.test(url) ? json({ memories: list }) : undefined),
  ]);
  renderPage(<MemoriesPage />);
  return fn;
}

async function openEditor() {
  fireEvent.click(await screen.findByRole('button', { name: /Trip to Rye/ }));
  return screen.findByTestId('memory-editor');
}

describe('MemoriesPage', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('loads libraries and lists memories', async () => {
    setup();

    expect(await screen.findByText('Trip to Rye')).toBeInTheDocument();
    expect(screen.getByLabelText('Library')).toBeInTheDocument();
  });

  it('shows an empty state and creates a memory', async () => {
    const fetchMock = setup({ memories: [] });

    expect(await screen.findByTestId('memories-empty')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('new-memory'));

    expect(await screen.findByTestId('memory-editor')).toBeInTheDocument();
    expect(screen.getByLabelText('Memory title')).toHaveValue('Untitled memory');
    expect(called(fetchMock, 'POST', '/api/v1/libraries/lib1/memories')).toBe(true);
  });

  it('opens the editor and renders a markdown preview', async () => {
    setup();
    await openEditor();

    const preview = screen.getByLabelText('Markdown preview');
    expect(preview.innerHTML).toContain('<strong>the pier</strong>');
    expect(preview.innerHTML).toContain('md-ref md-ref-album');
  });

  it('autosaves on edit and reflects the save status', async () => {
    const fetchMock = setup();
    await openEditor();

    const body = await screen.findByLabelText('Memory body');
    fireEvent.change(body, { target: { value: 'Edited body with **changes**.' } });

    const status = await screen.findByText('Saved', undefined, { timeout: 3000 });
    expect(status).toBeInTheDocument();

    const put = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/api/v1/libraries/lib1/memories/mem1') && init?.method === 'PUT',
    );
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      title: 'Trip to Rye',
      body: 'Edited body with **changes**.',
    });
  });

  it('reports a failed autosave instead of claiming the draft is safe', async () => {
    mockApi([
      (url, init) =>
        /\/memories\/mem1$/.test(url) && init?.method === 'PUT'
          ? json({ error: { code: 'CONFLICT', message: 'Someone else edited this.', request_id: '1' } }, 409)
          : undefined,
      (url) => (/\/libraries\/lib1\/memories$/.test(url) ? json({ memories: [memory] }) : undefined),
    ]);
    renderPage(<MemoriesPage />);
    await screen.findByText('Trip to Rye');
    fireEvent.click(screen.getByRole('button', { name: /Trip to Rye/ }));
    const body = await screen.findByLabelText('Memory body');

    fireEvent.change(body, { target: { value: 'Conflicting edit.' } });

    expect(
      await screen.findByText('Save failed: Someone else edited this.', undefined, {
        timeout: 3000,
      }),
    ).toBeInTheDocument();
  });

  it('lists version history and restores a draft', async () => {
    setup();
    await openEditor();

    const versionSelect = await screen.findByLabelText(/Restore an earlier version/);
    await waitFor(() => {
      expect(versionSelect).toHaveTextContent('v1');
    });

    fireEvent.change(versionSelect, { target: { value: '1' } });
    expect(screen.getByLabelText('Memory body')).toHaveValue('Draft one.');
  });

  it('deletes a memory after confirming the dialog', async () => {
    const fetchMock = setup();
    const confirmSpy = vi.spyOn(window, 'confirm');
    await openEditor();

    fireEvent.click(screen.getByTestId('delete-memory'));
    const dialog = await screen.findByTestId('delete-memory-dialog');
    expect(within(dialog).getByText('Trip to Rye')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(called(fetchMock, 'DELETE', '/api/v1/libraries/lib1/memories/mem1')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByText('Trip to Rye')).not.toBeInTheDocument();
    });
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('keeps the memory when the delete dialog is cancelled', async () => {
    const fetchMock = setup();
    await openEditor();

    fireEvent.click(screen.getByTestId('delete-memory'));
    const dialog = await screen.findByTestId('delete-memory-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByTestId('delete-memory-dialog')).not.toBeInTheDocument();
    });
    expect(called(fetchMock, 'DELETE', '/memories/mem1')).toBe(false);
    expect(screen.getByTestId('memory-editor')).toBeInTheDocument();
  });
});

describe('MemoryEditor ref picker', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('inserts a picked reference at the caret', async () => {
    mockApi([
      (url) => (/\/libraries\/lib1\/memories$/.test(url) ? json({ memories: [memory] }) : undefined),
      (url) => (/\/memories\/mem1\/versions$/.test(url) ? json(versions) : undefined),
      (url) =>
        url.includes('/search?q=beach')
          ? json({ files: [{ id: 'f9', name: 'beach.jpg', folder_path: 'Rye', rel_path: 'Rye/beach.jpg' }] })
          : undefined,
    ]);
    renderPage(<MemoriesPage />);
    await screen.findByText('Trip to Rye');
    fireEvent.click(screen.getByRole('button', { name: /Trip to Rye/ }));
    const body = (await screen.findByLabelText('Memory body')) as HTMLTextAreaElement;

    fireEvent.change(body, { target: { value: 'See: ' } });
    body.focus();
    body.setSelectionRange(5, 5);

    fireEvent.change(screen.getByTestId('ref-search'), { target: { value: 'beach' } });
    const result = await screen.findByTestId('ref-result-f9');
    fireEvent.click(result);

    expect(body.value).toBe('See: [[media:f9|beach.jpg]]');
  });

  it('searches the kind that is selected, and says when nothing matches', async () => {
    mockApi([
      (url) => (/\/libraries\/lib1\/memories$/.test(url) ? json({ memories: [memory] }) : undefined),
      (url) => (/\/memories\/mem1\/versions$/.test(url) ? json(versions) : undefined),
      (url) => (url.endsWith('/api/v1/libraries/lib1/tags') ? json({ tags: [] }) : undefined),
    ]);
    renderPage(<MemoriesPage />);
    await screen.findByText('Trip to Rye');
    fireEvent.click(screen.getByRole('button', { name: /Trip to Rye/ }));
    await screen.findByTestId('memory-editor');

    fireEvent.click(screen.getByTestId('ref-kind-tag'));
    fireEvent.change(screen.getByTestId('ref-search'), { target: { value: 'zzz' } });

    expect(await screen.findByTestId('ref-empty')).toHaveTextContent('No tag match “zzz”.');
  });
});
