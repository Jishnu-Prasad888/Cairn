/**
 * The signed-in user's favorites in a library, as a set of file ids, with
 * optimistic add and remove. Grids use it to draw the star badge; selection
 * and context menus use it to offer the right action.
 */

import { useCallback, useEffect, useState } from 'react';

import { addFavorite, listFavorites, removeFavorite } from '../../api/queries';

/** One file to favorite or unfavorite, in its own library. */
export interface FavoriteTarget {
  id: string;
  /** The library the file lives in; defaults to the hook's first library. */
  libraryId?: string;
}

export interface Favorites {
  ids: ReadonlySet<string>;
  has: (id: string) => boolean;
  /** Add (or with `false`, remove) every target; resolves to how many failed. */
  set: (targets: FavoriteTarget[], value: boolean) => Promise<number>;
}

/**
 * The signed-in user's favorites, as a set of file ids, with optimistic add and
 * remove. On a page that merges several open libraries the set spans all of
 * them, and each toggle writes to the library its file lives in.
 */
export function useFavorites(libraryIds: readonly string[], refreshKey = 0): Favorites {
  const [state, setState] = useState<{ key: string; ids: ReadonlySet<string> } | null>(null);
  const key = libraryIds.join(',');

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    Promise.allSettled(
      libraryIds.map((libraryId) =>
        listFavorites(libraryId).then((resp) => (resp.files ?? []).map((f) => f.id)),
      ),
    ).then((results) => {
      if (cancelled) return;
      const ids = new Set<string>();
      for (const result of results) {
        if (result.status === 'fulfilled') {
          result.value.forEach((id) => ids.add(id));
        }
      }
      setState({ key, ids });
    });
    return () => {
      cancelled = true;
    };
  }, [key, refreshKey, libraryIds]);

  const ids = state && state.key === key ? state.ids : EMPTY;

  const set = useCallback(
    async (targets: FavoriteTarget[], value: boolean) => {
      if (targets.length === 0) return 0;
      // Optimistic: the star changes now, and is put back for any that fail.
      setState((prev) => {
        const next = new Set(prev?.key === key ? prev.ids : []);
        targets.forEach((t) => (value ? next.add(t.id) : next.delete(t.id)));
        return { key, ids: next };
      });
      const results = await Promise.allSettled(
        targets.map((t) => {
          const libraryId = t.libraryId || libraryIds[0] || '';
          return value ? addFavorite(libraryId, t.id) : removeFavorite(libraryId, t.id);
        }),
      );
      const failed = targets.filter((_, i) => results[i]?.status === 'rejected');
      if (failed.length) {
        setState((prev) => {
          const next = new Set(prev?.key === key ? prev.ids : []);
          failed.forEach((t) => (value ? next.delete(t.id) : next.add(t.id)));
          return { key, ids: next };
        });
      }
      return failed.length;
    },
    [key, libraryIds],
  );

  const has = useCallback((id: string) => ids.has(id), [ids]);

  return { ids, has, set };
}

const EMPTY: ReadonlySet<string> = new Set();
