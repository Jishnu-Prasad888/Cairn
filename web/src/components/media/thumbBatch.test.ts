import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fileFixture } from '../../test/harness';
import {
  parseThumbBatch,
  resetThumbBatch,
  setThumbBatching,
  thumbSizeFor,
  useBatchedThumb,
} from './thumbBatch';
import { resetThumbnailQueue } from './thumbnailQueue';

/** A batch response body in the server's format (see thumbbatch.go). */
function batchBody(items: Array<{ id: string; bytes?: number[] }>): ArrayBuffer {
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      items: items.map((i) =>
        i.bytes ? { id: i.id, size: i.bytes.length } : { id: i.id, missing: true },
      ),
    }),
  );
  const data = items.flatMap((i) => i.bytes ?? []);
  const out = new Uint8Array(8 + manifest.length + data.length);
  out.set(new TextEncoder().encode('CTB1'), 0);
  new DataView(out.buffer).setUint32(4, manifest.length);
  out.set(manifest, 8);
  out.set(data, 8 + manifest.length);
  return out.buffer;
}

describe('parseThumbBatch', () => {
  it('splits the body into each file’s bytes, in manifest order', async () => {
    const parts = parseThumbBatch(
      batchBody([{ id: 'a', bytes: [1, 2, 3] }, { id: 'b' }, { id: 'c', bytes: [9] }]),
    );
    expect(parts.get('b')).toBeNull();
    expect(new Uint8Array(await parts.get('a')!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(await parts.get('c')!.arrayBuffer())).toEqual(new Uint8Array([9]));
  });

  it('rejects a body that is not a batch', () => {
    expect(() => parseThumbBatch(new TextEncoder().encode('{"error":1}').buffer)).toThrow();
  });

  it('rejects a truncated body', () => {
    const body = batchBody([{ id: 'a', bytes: [1, 2, 3, 4] }]);
    expect(() => parseThumbBatch(body.slice(0, body.byteLength - 2))).toThrow();
  });
});

describe('thumbSizeFor', () => {
  it('uses the small thumbnail for small tiles and the full one for large', () => {
    expect(thumbSizeFor(120)).toBe('sm');
    expect(thumbSizeFor(400)).toBe('md');
  });
});

describe('useBatchedThumb', () => {
  const created: string[] = [];
  beforeEach(() => {
    setThumbBatching(true);
    resetThumbnailQueue();
    let n = 0;
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: () => {
          const url = `blob:thumb-${(n += 1)}`;
          created.push(url);
          return url;
        },
        revokeObjectURL: () => {},
      }),
    );
  });
  afterEach(() => {
    setThumbBatching(false);
    resetThumbBatch();
    vi.unstubAllGlobals();
    created.length = 0;
  });

  it('fetches waiting tiles in one request and hands each its image', async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(
      async () =>
        new Response(
          batchBody([
            { id: 'f1', bytes: [1] },
            { id: 'f2', bytes: [2] },
          ]),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const f1 = fileFixture({ id: 'f1', media_type: 'photo' });
    const f2 = fileFixture({ id: 'f2', media_type: 'photo' });

    const one = renderHook(() => useBatchedThumb('lib1', f1, 'sm', true));
    const two = renderHook(() => useBatchedThumb('lib1', f2, 'sm', true));

    await waitFor(() => expect(one.result.current.src).toMatch(/^blob:/));
    await waitFor(() => expect(two.result.current.src).toMatch(/^blob:/));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/api/v1/libraries/lib1/thumbnails?size=sm');
    expect(decodeURIComponent(url)).toContain('ids=f1,f2');
  });

  it('reports a file the server has no thumbnail for as missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(batchBody([{ id: 'f3' }]))),
    );
    const f3 = fileFixture({ id: 'f3', media_type: 'photo' });
    const { result } = renderHook(() => useBatchedThumb('lib1', f3, 'sm', true));
    await waitFor(() => expect(result.current.missing).toBe(true));
    expect(result.current.src).toBeUndefined();
  });

  it('falls back to single requests when the batch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    );
    const f4 = fileFixture({ id: 'f4', media_type: 'photo' });
    const { result } = renderHook(() => useBatchedThumb('lib1', f4, 'md', true));
    await waitFor(() => expect(result.current.missing).toBe(true));
  });

  it('does nothing when inactive, and says to load on its own', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const f5 = fileFixture({ id: 'f5', media_type: 'photo' });
    const { result } = renderHook(() => useBatchedThumb('lib1', f5, 'sm', false));
    act(() => {});
    expect(result.current.missing).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
