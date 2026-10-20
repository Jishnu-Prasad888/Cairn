import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { notifyLibraryChanged } from '../../api/libraryEvents';
import { json, mockApi, originalFetch } from '../../test/harness';
import { PAGE_SIZE, useFileListing } from './useFileListing';
import type { ListingQuery } from './useFileListing';

const QUERY: ListingQuery = {
  q: '',
  type: 'photo',
  recursive: true,
  sort: 'mod_time',
  order: 'desc',
  minSizeMb: '',
  maxSizeMb: '',
  from: '',
  to: '',
};

/** A library of `count` photos, served `PAGE_SIZE` at a time by cursor. */
function servePhotos(count: number) {
  return mockApi([
    (url) => {
      if (!url.includes('/files?')) return undefined;
      const cursor = Number(new URL(url, 'http://x').searchParams.get('cursor') ?? 0);
      const end = Math.min(cursor + PAGE_SIZE, count);
      const files = Array.from({ length: end - cursor }, (_, i) => ({
        id: `f${cursor + i}`,
        name: `p${cursor + i}.jpg`,
        rel_path: `p${cursor + i}.jpg`,
        media_type: 'photo',
      }));
      return json({ files, total: count, next_cursor: end < count ? String(end) : '' });
    },
  ]);
}

describe('useFileListing', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('keeps every loaded page when the library changes on disk', async () => {
    servePhotos(350);
    const { result } = renderHook(() => useFileListing('lib1', QUERY));
    await waitFor(() => expect(result.current.files).toHaveLength(100));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.files).toHaveLength(200));

    act(() => notifyLibraryChanged('lib1'));
    // Never back to a skeleton, and never cut short to the first page.
    expect(result.current.loading).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.files).toHaveLength(200);
    expect(result.current.hasMore).toBe(true);
  });

  it('reloads in place instead of showing the loading state', async () => {
    servePhotos(150);
    const { result } = renderHook(() => useFileListing('lib1', QUERY));
    await waitFor(() => expect(result.current.files).toHaveLength(100));
    act(() => result.current.reload());
    expect(result.current.loading).toBe(false);
    expect(result.current.files).toHaveLength(100);
  });

  it('comes back to the listing it left, every page of it', async () => {
    servePhotos(350);
    const first = renderHook(() => useFileListing('lib1', QUERY));
    await waitFor(() => expect(first.result.current.files).toHaveLength(100));
    act(() => first.result.current.loadMore());
    await waitFor(() => expect(first.result.current.files).toHaveLength(200));
    first.unmount();

    const again = renderHook(() => useFileListing('lib1', QUERY));
    expect(again.result.current.loading).toBe(false);
    expect(again.result.current.files).toHaveLength(200);
  });
});
