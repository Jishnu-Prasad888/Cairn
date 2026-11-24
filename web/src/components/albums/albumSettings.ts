/**
 * How the Albums grid is arranged for this person: its sort, the albums
 * pinned to the top (at most five, the latest pinned first), and the
 * libraries whose albums it leaves out. Stored server-side per account
 * (`/settings/albums`), so it follows the person to any browser.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiGet, apiPatch } from '../../api/client';
import type { Album } from '../../api/types';

export type AlbumSort = 'name_asc' | 'name_desc' | 'created_desc' | 'created_asc';

export const ALBUM_SORTS: Array<{ value: AlbumSort; label: string }> = [
  { value: 'created_desc', label: 'Newest created' },
  { value: 'created_asc', label: 'Oldest created' },
  { value: 'name_asc', label: 'Name (A–Z)' },
  { value: 'name_desc', label: 'Name (Z–A)' },
];

export const MAX_PINNED_ALBUMS = 5;

export interface PinnedAlbum {
  library_id: string;
  album_id: string;
}

export interface AlbumSettings {
  sort: AlbumSort;
  pinned: PinnedAlbum[];
  hidden_libraries: string[];
}

export const DEFAULT_ALBUM_SETTINGS: AlbumSettings = {
  sort: 'created_desc',
  pinned: [],
  hidden_libraries: [],
};

export const getAlbumSettings = () => apiGet<{ settings: AlbumSettings }>('/settings/albums');

export const updateAlbumSettings = (patch: Partial<AlbumSettings>) =>
  apiPatch<{ settings: AlbumSettings }>('/settings/albums', patch);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Albums in the chosen order. Ties keep a stable, readable order. */
export function sortAlbums(albums: readonly Album[], sort: AlbumSort): Album[] {
  const list = [...albums];
  const byName = (a: Album, b: Album) => collator.compare(a.name, b.name);
  const byCreated = (a: Album, b: Album) => a.created_at.localeCompare(b.created_at);
  list.sort((a, b) => {
    switch (sort) {
      case 'name_asc':
        return byName(a, b) || byCreated(b, a);
      case 'name_desc':
        return byName(b, a) || byCreated(b, a);
      case 'created_asc':
        return byCreated(a, b) || byName(a, b);
      default:
        return byCreated(b, a) || byName(a, b);
    }
  });
  return list;
}

const pinKey = (libraryId: string, albumId: string) => `${libraryId}:${albumId}`;

export interface ArrangedAlbums {
  /** Pinned albums that are shown, latest pinned first. */
  pinned: Album[];
  /** Everything else that is shown, in the chosen order. */
  rest: Album[];
  /** Search matches in hidden libraries (only while searching). */
  hiddenMatches: Album[];
  /** How many albums the hidden libraries hold in all. */
  hiddenCount: number;
}

/**
 * Split the albums into what the grid shows: pins first, then the rest, and
 * — while a search is on — the matches from hidden libraries kept apart.
 */
export function arrangeAlbums(
  albums: readonly Album[],
  settings: AlbumSettings,
  filter: string,
  fallbackLibraryId: string,
): ArrangedAlbums {
  const hidden = new Set(settings.hidden_libraries);
  const libOf = (a: Album) => a.library_id || fallbackLibraryId;
  const matches = (a: Album) => !filter || a.name.toLowerCase().includes(filter);
  const pinOrder = new Map(settings.pinned.map((p, i) => [pinKey(p.library_id, p.album_id), i]));

  const shown: Album[] = [];
  const hiddenMatches: Album[] = [];
  let hiddenCount = 0;
  for (const a of albums) {
    if (hidden.has(libOf(a))) {
      hiddenCount += 1;
      if (filter && matches(a)) hiddenMatches.push(a);
    } else if (matches(a)) {
      shown.push(a);
    }
  }
  const pinned = shown
    .filter((a) => pinOrder.has(pinKey(libOf(a), a.id)))
    .sort((a, b) => pinOrder.get(pinKey(libOf(a), a.id))! - pinOrder.get(pinKey(libOf(b), b.id))!);
  const rest = sortAlbums(
    shown.filter((a) => !pinOrder.has(pinKey(libOf(a), a.id))),
    settings.sort,
  );
  return { pinned, rest, hiddenMatches: sortAlbums(hiddenMatches, settings.sort), hiddenCount };
}

export interface AlbumSettingsState {
  settings: AlbumSettings;
  loaded: boolean;
  isPinned: (album: Album) => boolean;
  /** Pin (to the front) or unpin. False when pinning would pass the limit. */
  togglePin: (album: Album) => boolean;
  setSort: (sort: AlbumSort) => void;
  setHiddenLibraries: (ids: string[]) => void;
  /** Replace the pins (dropping ones whose album is gone). */
  setPinned: (pins: PinnedAlbum[]) => void;
  error: string | null;
}

/** The person's album settings, changed optimistically and saved behind. */
export function useAlbumSettings(fallbackLibraryId: string): AlbumSettingsState {
  const [settings, setSettings] = useState<AlbumSettings>(DEFAULT_ALBUM_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(settings);
  useEffect(() => {
    current.current = settings;
  });

  useEffect(() => {
    let cancelled = false;
    getAlbumSettings()
      .then((r) => {
        if (cancelled) return;
        setSettings({ ...DEFAULT_ALBUM_SETTINGS, ...r.settings });
        setLoaded(true);
      })
      .catch(() => {
        // The defaults stand in; the grid works without saved preferences.
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const apply = useCallback((patch: Partial<AlbumSettings>) => {
    const before = current.current;
    const next = { ...before, ...patch };
    current.current = next;
    setSettings(next);
    setError(null);
    updateAlbumSettings(patch)
      .then((r) => setSettings({ ...DEFAULT_ALBUM_SETTINGS, ...r.settings }))
      .catch((e: unknown) => {
        // Put it back, so what is on screen is what is saved.
        current.current = before;
        setSettings(before);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  const libOf = useCallback((a: Album) => a.library_id || fallbackLibraryId, [fallbackLibraryId]);
  const isPinned = useCallback(
    (a: Album) => settings.pinned.some((p) => p.album_id === a.id && p.library_id === libOf(a)),
    [settings.pinned, libOf],
  );
  const togglePin = useCallback(
    (a: Album) => {
      const pins = current.current.pinned;
      const lib = libOf(a);
      const at = pins.findIndex((p) => p.album_id === a.id && p.library_id === lib);
      if (at >= 0) {
        apply({ pinned: pins.filter((_, i) => i !== at) });
        return true;
      }
      if (pins.length >= MAX_PINNED_ALBUMS) return false;
      // The latest pin leads.
      apply({ pinned: [{ library_id: lib, album_id: a.id }, ...pins] });
      return true;
    },
    [apply, libOf],
  );

  return {
    settings,
    loaded,
    isPinned,
    togglePin,
    setSort: (sort) => apply({ sort }),
    setHiddenLibraries: (ids) => apply({ hidden_libraries: ids }),
    setPinned: (pins) => apply({ pinned: pins }),
    error,
  };
}
