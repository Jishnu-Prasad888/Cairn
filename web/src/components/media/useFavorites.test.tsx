import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { json, mockApi, originalFetch } from '../../test/harness';
import { useFavorites } from './useFavorites';

describe('useFavorites', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetches once even when given a fresh array every render', async () => {
    const fn = mockApi([
      (url) => (url.includes('/favorites') ? json({ files: [{ id: 'f1' }] }) : undefined),
    ]);
    // An inline `['lib1']` is a new array on every render, as pages pass it.
    const { result, rerender } = renderHook(() => useFavorites(['lib1']));

    await waitFor(() => expect(result.current.has('f1')).toBe(true));
    rerender();
    rerender();
    // Give a runaway loop a chance to show itself.
    await new Promise((r) => setTimeout(r, 50));

    const calls = fn.mock.calls.filter(([input]) => String(input).includes('/favorites'));
    expect(calls).toHaveLength(1);
  });
});
