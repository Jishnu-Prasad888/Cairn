import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useScrollMemory } from './useScrollMemory';

/** jsdom does not scroll; stand in a window that does, with no height limit. */
function fakeScroll() {
  let y = 0;
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y });
  const scrollTo = vi.fn((arg: ScrollToOptions | number, top?: number) => {
    y = typeof arg === 'number' ? (top ?? 0) : (arg.top ?? y);
  });
  window.scrollTo = scrollTo as typeof window.scrollTo;
  return {
    scrollTo,
    /** The reader scrolls. */
    userScroll(to: number) {
      y = to;
      window.dispatchEvent(new Event('scroll'));
    },
  };
}

const flushFrame = () => act(() => new Promise((r) => requestAnimationFrame(() => r(null))));

describe('useScrollMemory', () => {
  let win: ReturnType<typeof fakeScroll>;
  beforeEach(() => {
    win = fakeScroll();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns to where the reader left the view', async () => {
    const first = renderHook(() => useScrollMemory('/photos|a', true));
    win.userScroll(4200);
    await flushFrame();
    first.unmount();

    win.userScroll(0); // another page, at its own top
    renderHook(() => useScrollMemory('/photos|a', true));
    expect(window.scrollY).toBe(4200);
  });

  it('waits for the grid before restoring', async () => {
    const first = renderHook(() => useScrollMemory('/files|root', true));
    win.userScroll(900);
    await flushFrame();
    first.unmount();
    win.userScroll(0);

    const again = renderHook(({ ready }) => useScrollMemory('/files|root', ready), {
      initialProps: { ready: false },
    });
    expect(window.scrollY).toBe(0);
    again.rerender({ ready: true });
    expect(window.scrollY).toBe(900);
  });

  it('starts a view it has never seen at the top', () => {
    win.userScroll(3000);
    renderHook(() => useScrollMemory('/videos|new', true));
    expect(window.scrollY).toBe(0);
  });

  it('does not move the window again once restored', async () => {
    const first = renderHook(() => useScrollMemory('/photos|a', true));
    win.userScroll(500);
    await flushFrame();
    first.unmount();

    const again = renderHook(() => useScrollMemory('/photos|a', true));
    win.scrollTo.mockClear();
    again.rerender();
    win.userScroll(800);
    await flushFrame();
    again.rerender();
    expect(win.scrollTo).not.toHaveBeenCalled();
  });
});
