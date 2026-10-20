/**
 * Coming back to a grid where it was left.
 *
 * Each view — a route plus what it lists (folder, filters, sort) — remembers
 * how far down the window was scrolled. Leaving for another page and coming
 * back, by Back or by the sidebar, puts the window back at that spot once the
 * grid is on screen again. A view never seen before starts at the top.
 *
 * Putting it back is the only scrolling done here, and the reader always
 * wins: a wheel, touch, key or click while it is still catching up (a grid
 * whose rows are still being measured) stops it where it is.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';

const positions = new Map<string, number>();
const MAX_VIEWS = 50;
/** How long to keep trying while the grid grows tall enough to reach the spot. */
const RESTORE_MS = 3000;

/** Forget every remembered position (another account signs in). */
export function forgetScrollPositions() {
  positions.clear();
}

function store(key: string, y: number) {
  positions.delete(key);
  positions.set(key, y);
  while (positions.size > MAX_VIEWS) {
    const oldest = positions.keys().next().value;
    if (oldest === undefined) break;
    positions.delete(oldest);
  }
}

/**
 * Remember and restore the window's scroll position for `key`. `ready` says
 * the grid for `key` is rendered (not a loading skeleton), so there is
 * something to scroll to.
 */
export function useScrollMemory(key: string | null, ready: boolean): void {
  const restoring = useRef(false);
  const restoredKey = useRef<string | null>(null);

  // Keep the position up to date while the reader scrolls, so whatever takes
  // them away — a link, Back, a shortcut — the last spot is already saved.
  useEffect(() => {
    if (!key) return;
    let frame = 0;
    const onScroll = () => {
      if (restoring.current || restoredKey.current !== key) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => store(key, window.scrollY));
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
    };
  }, [key]);

  // Saved once more as the view goes away, before the next page can change
  // the window's height (and with it the scroll position).
  useLayoutEffect(() => {
    if (!key) return;
    return () => {
      if (!restoring.current && restoredKey.current === key) store(key, window.scrollY);
    };
  }, [key]);

  useLayoutEffect(() => {
    if (!key || !ready || restoredKey.current === key) return;
    restoredKey.current = key;
    const target = positions.get(key) ?? 0;
    window.scrollTo({ top: target, behavior: 'instant' });
    if (Math.abs(window.scrollY - target) <= 1) return;

    // The grid is not tall enough yet (rows still being laid out, or more
    // pages on their way): keep reaching for the spot for a moment.
    restoring.current = true;
    const started = performance.now();
    let frame = 0;
    const stop = () => {
      restoring.current = false;
      cancelAnimationFrame(frame);
      for (const type of USER_INPUT) window.removeEventListener(type, stop, true);
    };
    const step = () => {
      window.scrollTo({ top: target, behavior: 'instant' });
      if (Math.abs(window.scrollY - target) <= 1 || performance.now() - started > RESTORE_MS) {
        stop();
        return;
      }
      frame = requestAnimationFrame(step);
    };
    for (const type of USER_INPUT)
      window.addEventListener(type, stop, { capture: true, passive: true });
    frame = requestAnimationFrame(step);
    return stop;
  }, [key, ready]);
}

const USER_INPUT = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;
