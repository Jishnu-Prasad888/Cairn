import { useCallback, useSyncExternalStore } from 'react';

import { BREAKPOINTS } from './breakpoints';

/** Phones: the width below which the app switches to its compact layout. */
export const COMPACT_QUERY = `(max-width: ${BREAKPOINTS.compact - 1}px)`;

/**
 * Whether a media query matches, kept current as the window changes. For the
 * few layout decisions that change what is rendered rather than how it looks
 * (CSS handles the rest). Always false where `matchMedia` is missing (jsdom).
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  const get = () =>
    typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches;
  return useSyncExternalStore(subscribe, get, () => false);
}
