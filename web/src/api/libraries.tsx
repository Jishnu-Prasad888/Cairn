/* eslint-disable react-refresh/only-export-components --
 * A React context necessarily lives beside the hook that reads it and the
 * component that provides it. Splitting them would only hide a real coupling
 * behind two imports, so the fast-refresh granularity is accepted here.
 */
/**
 * One place that knows how the frontend talks about libraries.
 *
 * Every library-scoped page needs the same two things: the list of libraries
 * the signed-in user can read, and the currently selected one. That was
 * copy-pasted into six pages with subtle differences (some defaulted to the
 * first library, some to the first *online* one, some ignored offline
 * libraries entirely), which is how a member account ended up on an empty
 * page. This hook is the single source of truth.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { useAuth } from '../auth/authContext';
import { ApiError, apiGet } from './client';
import type { Library } from './types';

export const LIBRARY_STORAGE_KEY = 'cairn.library';
/** The set of libraries the user has opened, as a JSON array of ids. */
export const OPEN_LIBRARIES_STORAGE_KEY = 'cairn.libraries.open';

/** Read the remembered library id, or null when there is nothing to restore. */
export function readStoredLibraryId(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(LIBRARY_STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode, disabled cookies).
    return null;
  }
}

export function storeLibraryId(id: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (id) {
      localStorage.setItem(LIBRARY_STORAGE_KEY, id);
    } else {
      localStorage.removeItem(LIBRARY_STORAGE_KEY);
    }
  } catch {
    // A failed write only means the choice is not remembered next visit.
  }
}

/** The libraries that were open last visit. */
export function readOpenLibraryIds(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(OPEN_LIBRARIES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function storeOpenLibraryIds(ids: string[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (ids.length > 0) {
      localStorage.setItem(OPEN_LIBRARIES_STORAGE_KEY, JSON.stringify(ids));
    } else {
      localStorage.removeItem(OPEN_LIBRARIES_STORAGE_KEY);
    }
  } catch {
    // A failed write only means the choice is not remembered next visit.
  }
}

export interface LibrariesState {
  /** True until the first /libraries response has been handled. */
  loading: boolean;
  /** Libraries the signed-in user can read. Empty is a valid, non-error state. */
  libraries: Library[];
  /**
   * The "primary" library. Most single-library actions (upload, new album,
   * permissions) act on this one; the content pages aggregate every open
   * library instead (see `openLibraries`).
   */
  library: Library | null;
  /** Id of the primary library, for building single-library request paths. */
  libraryId: string | null;
  /** Every library the user has opened, in the order they opened them. */
  openLibraries: Library[];
  /** Ids of the open libraries, validated against the visible list. */
  openLibraryIds: string[];
  /** Select the primary library and make sure it is open; persisted. */
  selectLibrary: (id: string) => void;
  /** Replace the whole open set at once. */
  setOpenLibraries: (ids: string[]) => void;
  /** Open a library if it is closed, close it if it is open. */
  toggleLibraryOpen: (id: string) => void;
  /** True when `id` is currently open. */
  isLibraryOpen: (id: string) => boolean;
  /** Re-fetch the list, e.g. after registering or unregistering a library. */
  refresh: () => void;
  /** A load failure. Distinct from "no libraries". */
  error: string | null;
  /** True when the list loaded and there is nothing to show. */
  isEmpty: boolean;
  /** True when the primary library's storage is unreachable. */
  libraryOffline: boolean;
}

const LibrariesContext = createContext<LibrariesState | null>(null);

/**
 * Loads the library list once for the whole app and shares it with every page.
 *
 * The selection is validated against the list: if a remembered library is no
 * longer visible (revoked, unregistered, or the user is now a different
 * account) it falls back to the first available one rather than leaving pages
 * pointed at a library that will 404.
 */
export function LibrariesProvider({ children }: { children: ReactNode }) {
  const [requestedId, setRequestedId] = useState<string | null>(() => readStoredLibraryId());
  const [requestedOpen, setRequestedOpen] = useState<string[]>(() => readOpenLibraryIds());
  const [reloadKey, setReloadKey] = useState(0);
  // The list is per account. Fetching it before anyone is signed in yields a
  // 401 that would otherwise stay on screen after sign-in ("authentication
  // required" until a manual reload), so it follows the signed-in user.
  const { user, loading: authLoading } = useAuth();
  const userId = user?.id ?? null;
  const requestKey = `${userId}:${reloadKey}`;

  // The response is tagged with the request it belongs to, so `loading` is
  // derived during render instead of being toggled around the fetch. This is
  // also what makes a refresh show the spinner again instead of silently
  // keeping the stale list on screen.
  const [settled, setSettled] = useState<
    { key: string; libraries: Library[] } | { key: string; message: string } | null
  >(null);

  useEffect(() => {
    if (userId === null) return;
    let cancelled = false;
    apiGet<{ libraries: Library[] }>('/libraries')
      .then((resp) => {
        if (cancelled) return;
        setSettled({ key: requestKey, libraries: resp.libraries ?? [] });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setSettled({
          key: requestKey,
          message: e instanceof ApiError ? e.message : 'Could not load libraries.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [requestKey, userId]);

  const loading =
    authLoading || (userId !== null && (settled === null || settled.key !== requestKey));
  const error =
    settled !== null && settled.key === requestKey && 'message' in settled ? settled.message : null;
  const libraries = useMemo(
    () =>
      settled !== null && settled.key === requestKey && 'libraries' in settled
        ? settled.libraries
        : [],
    [settled, requestKey],
  );

  // The selection is validated against the list: a remembered library that is
  // no longer visible (revoked, unregistered, or a different account) falls
  // back to the first available one rather than leaving every page pointed at a
  // library that will 404.
  const selectedId = useMemo(() => {
    if (libraries.length === 0) return null;
    if (requestedId && libraries.some((lib) => lib.id === requestedId)) return requestedId;
    // Prefer an online library: an offline one cannot serve media, and silently
    // selecting it would make every page look broken.
    const firstOnline = libraries.find((lib) => lib.status !== 'offline');
    return (firstOnline ?? libraries[0])?.id ?? null;
  }, [libraries, requestedId]);

  // The open set is the requested one, minus any library that is no longer
  // visible (revoked or unregistered). It is never empty while a library
  // exists: it falls back to the single selected library, so every page still
  // has something to show.
  const visibleIds = useMemo(() => new Set(libraries.map((lib) => lib.id)), [libraries]);
  const openLibraryIds = useMemo(() => {
    const kept = requestedOpen.filter((id) => visibleIds.has(id));
    if (kept.length > 0) return kept;
    return selectedId ? [selectedId] : [];
  }, [requestedOpen, visibleIds, selectedId]);

  // The primary library is the selected one when it is open, else the first
  // open one — used for the actions that can only target a single library.
  const primaryId = useMemo(() => {
    if (selectedId && openLibraryIds.includes(selectedId)) return selectedId;
    return openLibraryIds[0] ?? null;
  }, [openLibraryIds, selectedId]);

  const selectLibrary = useCallback((id: string) => {
    setRequestedId(id);
    storeLibraryId(id);
    setRequestedOpen((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      storeOpenLibraryIds(next);
      return next;
    });
  }, []);

  const setOpenLibraries = useCallback(
    (ids: string[]) => {
      setRequestedOpen(ids);
      storeOpenLibraryIds(ids);
      if (ids.length > 0 && !ids.includes(requestedId ?? '')) {
        setRequestedId(ids[0]!);
        storeLibraryId(ids[0]!);
      }
    },
    [requestedId],
  );

  const toggleLibraryOpen = useCallback(
    (id: string) => {
      const isOpen = openLibraryIds.includes(id);
      // Keep at least one library open: every content page needs one to show.
      if (isOpen && openLibraryIds.length <= 1) return;
      const next = isOpen ? openLibraryIds.filter((x) => x !== id) : [...openLibraryIds, id];
      setOpenLibraries(next);
    },
    [openLibraryIds, setOpenLibraries],
  );

  const isLibraryOpen = useCallback((id: string) => openLibraryIds.includes(id), [openLibraryIds]);

  const refresh = useCallback(() => setReloadKey((key) => key + 1), []);

  const library = useMemo(
    () => libraries.find((lib) => lib.id === primaryId) ?? null,
    [libraries, primaryId],
  );

  const openLibraries = useMemo(
    () =>
      openLibraryIds
        .map((id) => libraries.find((lib) => lib.id === id))
        .filter((lib): lib is Library => lib !== undefined),
    [libraries, openLibraryIds],
  );

  const value = useMemo<LibrariesState>(
    () => ({
      loading,
      libraries,
      library,
      libraryId: library?.id ?? null,
      openLibraries,
      openLibraryIds,
      selectLibrary,
      setOpenLibraries,
      toggleLibraryOpen,
      isLibraryOpen,
      refresh,
      error,
      isEmpty: !loading && error === null && libraries.length === 0,
      libraryOffline: library?.status === 'offline',
    }),
    [
      libraries,
      loading,
      library,
      openLibraries,
      openLibraryIds,
      selectLibrary,
      setOpenLibraries,
      toggleLibraryOpen,
      isLibraryOpen,
      refresh,
      error,
    ],
  );

  return <LibrariesContext.Provider value={value}>{children}</LibrariesContext.Provider>;
}

/**
 * Access the shared library list. Must be used inside {@link LibrariesProvider}.
 *
 * A component rendered outside the provider (a test, or a public share view
 * that has no session) gets an inert value rather than throwing, so shared
 * components do not need to know where they are mounted.
 */
export function useLibraries(): LibrariesState {
  const ctx = useContext(LibrariesContext);
  if (ctx) return ctx;
  return {
    loading: false,
    libraries: [],
    library: null,
    libraryId: null,
    openLibraries: [],
    openLibraryIds: [],
    selectLibrary: () => {},
    setOpenLibraries: () => {},
    toggleLibraryOpen: () => {},
    isLibraryOpen: () => false,
    refresh: () => {},
    error: null,
    isEmpty: false,
    libraryOffline: false,
  };
}

/**
 * Library state for a page that must not render before a library is chosen.
 * Returns a discriminated result so callers handle "loading" and "no
 * libraries" explicitly instead of rendering a broken page.
 */
export type LibraryGate =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | {
      kind: 'ready';
      library: Library;
      libraryId: string;
      libraries: Library[];
      /** Every library the user has opened; content pages aggregate these. */
      openLibraries: Library[];
      openLibraryIds: string[];
      selectLibrary: (id: string) => void;
    };

export function useLibraryGate(): LibraryGate {
  const state = useLibraries();
  const {
    loading,
    error,
    isEmpty,
    library,
    libraryId,
    libraries,
    openLibraries,
    openLibraryIds,
    selectLibrary,
  } = state;

  return useMemo<LibraryGate>(() => {
    if (loading) return { kind: 'loading' };
    if (error) return { kind: 'error', message: error };
    if (isEmpty || !library || !libraryId) return { kind: 'empty' };
    return {
      kind: 'ready',
      library,
      libraryId,
      libraries,
      openLibraries,
      openLibraryIds,
      selectLibrary,
    };
  }, [
    loading,
    error,
    isEmpty,
    library,
    libraryId,
    libraries,
    openLibraries,
    openLibraryIds,
    selectLibrary,
  ]);
}
