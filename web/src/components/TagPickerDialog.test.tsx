import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bodyOf,
  called,
  fileFixture,
  json,
  libraryFixture,
  mockApi,
  originalFetch,
  renderPage,
} from '../test/harness';
import { TagPickerDialog } from './TagPickerDialog';

const libraries = [
  libraryFixture(),
  libraryFixture({ id: 'lib2', name: 'Videos', root: '/srv/videos' }),
];

describe('TagPickerDialog', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("offers another library's tag and creates it in the file's library", async () => {
    const fn = mockApi(
      [
        (url, init) =>
          url.endsWith('/libraries/lib2/tags') && init?.method === 'POST'
            ? json({ tag: { id: 't2', name: 'family', created_at: '2026-01-01T00:00:00Z' } }, 201)
            : undefined,
        (url, init) =>
          url.endsWith('/libraries/lib2/files/f1/tags') && init?.method === 'POST'
            ? new Response(null, { status: 204 })
            : undefined,
        (url) =>
          url.endsWith('/libraries/lib1/tags')
            ? json({ tags: [{ id: 't1', name: 'family', created_at: '2026-01-01T00:00:00Z' }] })
            : undefined,
        (url) => (url.endsWith('/libraries/lib2/tags') ? json({ tags: [] }) : undefined),
      ],
      { libraries },
    );
    const onDone = vi.fn();
    renderPage(
      <TagPickerDialog
        open
        files={[fileFixture({ library_id: 'lib2' })]}
        onClose={() => {}}
        onDone={onDone}
      />,
      { libraries },
    );

    fireEvent.click(await screen.findByRole('button', { name: /family/ }));

    await waitFor(() =>
      expect(onDone).toHaveBeenCalledWith({ name: 'family', added: 1, failed: 0 }),
    );
    expect(bodyOf(fn, 'POST', '/libraries/lib2/tags')).toEqual({ name: 'family' });
    expect(bodyOf(fn, 'POST', '/libraries/lib2/files/f1/tags')).toEqual({ tag_id: 't2' });
    expect(called(fn, 'POST', '/libraries/lib1/tags')).toBe(false);
  });
});
