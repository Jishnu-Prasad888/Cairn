/**
 * Loading a listing of files, page by page.
 *
 * One hook for every media surface (Photos, Videos, Files, search), so the
 * rules are the same everywhere:
 *
 * - a plain listing uses `GET /files`, which honours sort order and folders;
 * - a query, a person/album/tag, or a date or size filter uses `GET /search`,
 *   because only search understands those (it returns relevance order, or id
 *   order without a query);
 * - pages are fetched with the server's cursor and appended; a new query
 *   discards the old pages and cancels anything in flight.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useLibrariesChangeTick, useLibraryChangeTick } from '../../api/libraryEvents';

import { listFiles, listFolders, searchFiles } from '../../api/queries';
import type { FileSort, MediaFilter, SortOrder } from '../../api/queries';
import type { FileListResponse, FileSummary, Folder } from '../../api/types';

export const PAGE_SIZE = 100;
const MB = 1024 * 1024;

/* ------------------------------ listing cache ------------------------------ */

/**
 * The last few listings, every page that was loaded, kept for when the reader
 * comes back. Returning to Photos (or to a folder) then shows exactly the list
 * that was left — so the scroll position can be put back — and refreshes it
 * behind the scenes instead of starting again from page one.
 */
const CACHE_SIZE = 12;
const listingCache = new Map<string, unknown>();

function recall<T>(key: string): T | undefined {
  const hit = listingCache.get(key) as T | undefined;
  if (hit !== undefined) {
    // Most recently used goes to the back.
    listingCache.delete(key);
    listingCache.set(key, hit);
  }
  return hit;
}

function remember(key: string, value: unknown) {
  listingCache.delete(key);
  listingCache.set(key, value);
  while (listingCache.size > CACHE_SIZE) {
    const oldest = listingCache.keys().next().value;
    if (oldest === undefined) break;
    listingCache.delete(oldest);
  }
}

/** Forget every cached listing — another account must never see this one's. */
export function clearListingCache() {
  listingCache.clear();
}

export interface ListingQuery {
  q: string;
  type?: MediaFilter | undefined;
  /** Folder to list; `undefined` with `recursive` means the whole library. */
  folder?: string | undefined;
  recursive?: boolean | undefined;
  sort: FileSort;
  order: SortOrder;
  /** Megabytes, as typed. Empty means no bound. */
  minSizeMb: string;
  maxSizeMb: string;
  /** `YYYY-MM-DD`, as a date input gives it. */
  from: string;
  to: string;
  person?: string | undefined;
  album?: string | undefined;
  tag?: string | undefined;
  /** Tag names to filter by: any of them, or all with `tagsAll`. */
  tags?: string[] | undefined;
  tagsAll?: boolean | undefined;
  /** Load the sub-folders of `folder` alongside the files. */
  withFolders?: boolean | undefined;
}

export interface FileListing {
  files: FileSummary[];
  folders: Folder[];
  total: number;
  /** True until the first page of the current query has arrived. */
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  reload: () => void;
  /**
   * Drop a file that was just deleted from the list on screen, without a
   * reload: the grid keeps its place instead of collapsing to a spinner and
   * jumping back to the top.
   */
  removeFile: (file: FileSummary) => void;
  /** Whether this listing went through search (no sort order). */
  searching: boolean;
}

export function usesSearch(query: ListingQuery): boolean {
  return Boolean(
    query.q.trim() ||
    query.person ||
    query.album ||
    query.tag ||
    query.tags?.length ||
    query.minSizeMb ||
    query.maxSizeMb ||
    query.from ||
    query.to,
  );
}

function toBytes(mb: string): number | undefined {
  if (!mb) return undefined;
  const n = Number(mb);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * MB) : undefined;
}

function fetchPage(
  libraryId: string,
  query: ListingQuery,
  cursor?: string,
): Promise<FileListResponse> {
  if (usesSearch(query)) {
    return searchFiles(libraryId, {
      q: query.q.trim() || undefined,
      type: query.type,
      folder: query.recursive ? undefined : query.folder || undefined,
      person: query.person,
      album: query.album,
      tag: query.tag,
      tags: query.tags?.length ? query.tags : undefined,
      tags_match: query.tags && query.tags.length > 1 && query.tagsAll ? 'all' : undefined,
      min_size: toBytes(query.minSizeMb),
      max_size: toBytes(query.maxSizeMb),
      from: query.from ? new Date(query.from).toISOString() : undefined,
      to: query.to ? new Date(`${query.to}T23:59:59`).toISOString() : undefined,
      cursor,
      limit: PAGE_SIZE,
    });
  }
  return listFiles(libraryId, {
    type: query.type,
    folder: query.folder,
    recursive: query.recursive || undefined,
    sort: query.sort,
    order: query.order,
    cursor,
    limit: PAGE_SIZE,
  });
}

/**
 * The first page of `query`, followed by as many more as it takes to cover
 * `want` files. A refresh asks for what is already on screen, so the list it
 * swaps in is no shorter than the one it replaces — a refresh that only
 * re-read page one would cut a deep scroll short and throw the reader back
 * to the top.
 */
async function fetchCovering(
  libraryId: string,
  query: ListingQuery,
  want: number,
): Promise<{ files: FileSummary[]; total: number; cursor: string | undefined }> {
  const first = await fetchPage(libraryId, query);
  let files = filterType(first.files ?? [], query.type);
  let cursor = first.next_cursor || undefined;
  while (cursor && files.length < want) {
    const page = await fetchPage(libraryId, query, cursor);
    files = [...files, ...filterType(page.files ?? [], query.type)];
    cursor = page.next_cursor || undefined;
  }
  return { files, total: first.total ?? first.files?.length ?? 0, cursor };
}

interface Loaded {
  /** The query this is a listing of (library and filters, not refreshes). */
  key: string;
  /** Bumped by every refresh, so a page fetched before one is not appended after it. */
  version: number;
  files: FileSummary[];
  folders: Folder[];
  total: number;
  cursor: string | undefined;
  error: string | null;
}

export function useFileListing(
  libraryId: string | null,
  query: ListingQuery,
  { enabled = true, refreshKey = 0 }: { enabled?: boolean; refreshKey?: number } = {},
): FileListing {
  const [run, setRun] = useState(0);
  // Files changed on disk: re-read behind the list already on screen.
  const changeTick = useLibraryChangeTick(libraryId);
  // What is listed. Reloads, uploads and changes on disk refresh it in place
  // rather than starting over, so they are not part of the key: the grid stays
  // up and keeps its scroll position while the fresh result is fetched.
  const key = enabled && libraryId ? `${libraryId}|${JSON.stringify(query)}` : null;
  const [loaded, setLoaded] = useState<Loaded | null>(() =>
    key ? (recall<Loaded>(`one|${key}`) ?? null) : null,
  );
  const [loadingMore, setLoadingMore] = useState(false);
  // Back to something listed before: show what was there straight away.
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key);
    const cached = key ? recall<Loaded>(`one|${key}`) : undefined;
    if (cached && loaded?.key !== key) setLoaded(cached);
  }
  useEffect(() => {
    if (loaded && !loaded.error) remember(`one|${loaded.key}`, loaded);
  }, [loaded]);
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  });
  const loadedRef = useRef(loaded);
  useEffect(() => {
    loadedRef.current = loaded;
  });

  useEffect(() => {
    if (key === null || libraryId === null) return;
    let cancelled = false;
    const current = queryRef.current;
    const previous = loadedRef.current?.key === key ? loadedRef.current : null;
    const wantFolders = current.withFolders && !usesSearch(current);
    Promise.all([
      wantFolders
        ? listFolders(libraryId, current.folder || undefined)
            .then((r) => r.folders ?? [])
            .catch(() => [] as Folder[])
        : Promise.resolve([] as Folder[]),
      fetchCovering(libraryId, current, previous?.files.length ?? 0),
    ])
      .then(([folders, page]) => {
        if (cancelled) return;
        setLoaded((prev) => ({
          key,
          version: (prev?.version ?? 0) + 1,
          folders,
          files: page.files,
          total: page.total,
          cursor: page.cursor,
          error: null,
        }));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setLoaded((prev) =>
          // A refresh that fails leaves what is on screen alone.
          prev && prev.key === key && prev.files.length > 0
            ? prev
            : {
                key,
                version: (prev?.version ?? 0) + 1,
                folders: [],
                files: [],
                total: 0,
                cursor: undefined,
                error: message,
              },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [key, libraryId, changeTick, run, refreshKey]);

  const current = loaded && loaded.key === key ? loaded : null;

  const loadMore = useCallback(() => {
    if (!libraryId || !current?.cursor || loadingMore) return;
    const { key: pageKey, version } = current;
    setLoadingMore(true);
    fetchPage(libraryId, queryRef.current, current.cursor)
      .then((page) => {
        setLoaded((prev) =>
          prev && prev.key === pageKey && prev.version === version
            ? {
                ...prev,
                files: [...prev.files, ...filterType(page.files ?? [], queryRef.current.type)],
                cursor: page.next_cursor || undefined,
              }
            : prev,
        );
      })
      .catch((error: unknown) => {
        setLoaded((prev) =>
          prev && prev.key === pageKey && prev.version === version
            ? { ...prev, error: error instanceof Error ? error.message : String(error) }
            : prev,
        );
      })
      .finally(() => setLoadingMore(false));
  }, [libraryId, current, loadingMore]);

  const reload = useCallback(() => setRun((n) => n + 1), []);

  const removeFile = useCallback((file: FileSummary) => {
    setLoaded((prev) => {
      if (!prev) return prev;
      const { files, cursor, removed } = without(prev.files, prev.cursor, file);
      return removed ? { ...prev, files, cursor, total: Math.max(0, prev.total - 1) } : prev;
    });
  }, []);

  return {
    files: current?.files ?? EMPTY_FILES,
    folders: current?.folders ?? EMPTY_FOLDERS,
    total: current?.total ?? 0,
    loading: key !== null && current === null,
    error: current?.error ?? null,
    hasMore: Boolean(current?.cursor),
    loadingMore,
    loadMore,
    reload,
    removeFile,
    searching: usesSearch(query),
  };
}

/**
 * `files` without `file`, and the pagination cursor to continue from. The
 * cursor names the last file loaded; if that is the one removed, the next
 * page starts after the file before it instead (the removed file is no
 * longer listed, so nothing is repeated or skipped).
 */
function without(
  files: FileSummary[],
  cursor: string | undefined,
  file: FileSummary,
): { files: FileSummary[]; cursor: string | undefined; removed: boolean } {
  const at = files.findIndex((f) => f.id === file.id);
  if (at < 0) return { files, cursor, removed: false };
  const next = [...files.slice(0, at), ...files.slice(at + 1)];
  const movedCursor =
    cursor !== undefined && cursor === file.rel_path ? next[at - 1]?.rel_path : cursor;
  return { files: next, cursor: movedCursor, removed: true };
}

/** Guard against an index that classified a file differently from the filter. */
function filterType(files: FileSummary[], type: MediaFilter | undefined): FileSummary[] {
  return type ? files.filter((f) => f.media_type === type) : files;
}

const EMPTY_FILES: FileSummary[] = [];
const EMPTY_FOLDERS: Folder[] = [];

/* --------------------- aggregated (multiple libraries) --------------------- */

/**
 * True when every open library is asked and the results are woven into one
 * list. The libraries' own lists arrive individually date- or name-sorted, so
 * they are interleaved with a k-way merge rather than concatenated — otherwise
 * the merged view would show all of the first library, then all of the next,
 * instead of one truly combined stream.
 */
function interleave(
  lists: readonly FileSummary[][],
  compare: (a: FileSummary, b: FileSummary) => number,
): FileSummary[] {
  const cursors = lists.map((list) => ({ list, i: 0 })).filter((c) => c.list.length > 0);
  const out: FileSummary[] = [];
  while (cursors.length > 1) {
    let best = 0;
    for (let k = 1; k < cursors.length; k++) {
      if (compare(cursors[k]!.list[cursors[k]!.i]!, cursors[best]!.list[cursors[best]!.i]!) < 0) {
        best = k;
      }
    }
    const c = cursors[best]!;
    out.push(c.list[c.i]!);
    c.i += 1;
    if (c.i >= c.list.length) cursors.splice(best, 1);
  }
  if (cursors.length === 1) out.push(...cursors[0]!.list.slice(cursors[0]!.i));
  return out;
}

/**
 * The order one listing sorts by, as a comparator. Files without a date always
 * sink to the bottom, whichever way round the dates run — an undated file has
 * no place in a date stream and should never push dated ones out of the way.
 */
function compareFor(sort: FileSort, order: SortOrder): (a: FileSummary, b: FileSummary) => number {
  const dir = order === 'asc' ? 1 : -1;
  return (a, b) => {
    if (sort === 'mod_time') {
      const av = a.mod_time;
      const bv = b.mod_time;
      if (av === bv) return 0;
      if (av == null || av === '') return 1;
      if (bv == null || bv === '') return -1;
      return dir * (av < bv ? -1 : 1);
    }
    let cmp: number;
    if (sort === 'size') cmp = (a.size_bytes ?? 0) - (b.size_bytes ?? 0);
    else if (sort === 'name') cmp = (a.name ?? '').localeCompare(b.name ?? '');
    else
      cmp = `${a.media_type ?? ''}:${a.name ?? ''}`.localeCompare(
        `${b.media_type ?? ''}:${b.name ?? ''}`,
      );
    return dir * cmp;
  };
}

export interface AggregatedFileListing {
  files: FileSummary[];
  folders: Folder[];
  total: number;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  reload: () => void;
  removeFile: (file: FileSummary) => void;
  searching: boolean;
}

/** The first page of one library, plus its pagination cursor. */
interface LibraryPage {
  libraryId: string;
  folders: Folder[];
  files: FileSummary[];
  total: number;
  cursor: string | undefined;
}

type AggregatedLoaded = {
  key: string;
  version: number;
  pages: LibraryPage[];
  error: string | null;
} | null;

/**
 * `useFileListing` over every open library at once.
 *
 * One listing per library is fetched, merged in open order, and tagged with the
 * library each folder/file belongs to. Pagination is per library: "load more"
 * advances every library that still has a cursor, so a deep Photos timeline
 * keeps working across several drives. A library that fails is skipped; the
 * merged view only errors when nothing could be loaded at all, so one unplugged
 * drive does not blank the page.
 */
export function useAggregatedFileListing(
  libraryIds: readonly string[],
  query: ListingQuery,
  { enabled = true, refreshKey = 0 }: { enabled?: boolean; refreshKey?: number } = {},
): AggregatedFileListing {
  const [run, setRun] = useState(0);
  // Files changed on disk in any open library: re-read behind the list already
  // on screen.
  const changeTick = useLibrariesChangeTick(libraryIds);
  const idsKey = libraryIds.join(',');
  // As in `useFileListing`: refreshes re-read in place, so they are not part of the key.
  const key = enabled && idsKey ? `${idsKey}|${JSON.stringify(query)}` : null;
  const [loaded, setLoaded] = useState<AggregatedLoaded>(() =>
    key ? (recall<AggregatedLoaded>(`all|${key}`) ?? null) : null,
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key);
    const cached = key ? recall<AggregatedLoaded>(`all|${key}`) : undefined;
    if (cached && loaded?.key !== key) setLoaded(cached);
  }
  useEffect(() => {
    if (loaded && !loaded.error) remember(`all|${loaded.key}`, loaded);
  }, [loaded]);
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  });
  const idsRef = useRef(libraryIds);
  useEffect(() => {
    idsRef.current = libraryIds;
  });
  const loadedRef = useRef(loaded);
  useEffect(() => {
    loadedRef.current = loaded;
  });

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    const current = queryRef.current;
    const ids = idsRef.current;
    if (ids.length === 0) return;
    const wantFolders = current.withFolders && !usesSearch(current);
    const previous = loadedRef.current?.key === key ? loadedRef.current : null;
    const onScreen = (libraryId: string) =>
      previous?.pages.find((p) => p.libraryId === libraryId)?.files.length ?? 0;

    Promise.allSettled(
      ids.map((libraryId) =>
        Promise.all([
          wantFolders
            ? listFolders(libraryId, current.folder || undefined)
                .then((r) => r.folders ?? [])
                .catch(() => [] as Folder[])
            : Promise.resolve([] as Folder[]),
          fetchCovering(libraryId, current, onScreen(libraryId)),
        ]).then(([folders, page]) => {
          const tag = (f: FileSummary): FileSummary => ({ ...f, library_id: libraryId });
          const tagFolder = (folder: Folder): Folder => ({ ...folder, library_id: libraryId });
          return {
            libraryId,
            folders: folders.map(tagFolder),
            files: page.files.map(tag),
            total: page.total,
            cursor: page.cursor,
          } satisfies LibraryPage;
        }),
      ),
    ).then((results) => {
      if (cancelled) return;
      const pages: LibraryPage[] = [];
      let firstError: string | null = null;
      let anyOk = false;
      for (const result of results) {
        if (result.status === 'fulfilled') {
          anyOk = true;
          pages.push(result.value);
        } else if (firstError === null) {
          firstError =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
        }
      }
      setLoaded((prev) => {
        // A refresh where every library failed leaves what is on screen alone.
        if (!anyOk && prev && prev.key === key && prev.pages.length > 0) return prev;
        return {
          key,
          version: (prev?.version ?? 0) + 1,
          pages,
          error: anyOk ? null : firstError,
        };
      });
    });
    return () => {
      cancelled = true;
    };
  }, [key, changeTick, run, refreshKey]);

  const current = loaded && loaded.key === key ? loaded : null;

  const loadMore = useCallback(() => {
    if (!current || loadingMore) return;
    const { key: stale, version } = current;
    const pending = current.pages.filter((p) => p.cursor && p.libraryId);
    if (pending.length === 0) return;
    setLoadingMore(true);
    Promise.allSettled(
      pending.map((p) =>
        fetchPage(p.libraryId, queryRef.current, p.cursor).then((page) => ({
          libraryId: p.libraryId,
          files: filterType(page.files ?? [], queryRef.current.type).map((f): FileSummary => ({
            ...f,
            library_id: p.libraryId,
          })),
          cursor: page.next_cursor || undefined,
        })),
      ),
    )
      .then((results) => {
        setLoaded((prev) => {
          if (!prev || prev.key !== stale || prev.version !== version) return prev;
          const pages = prev.pages.map((p) => {
            const more = results.find(
              (r) => r.status === 'fulfilled' && r.value.libraryId === p.libraryId,
            );
            if (!more || more.status !== 'fulfilled' || !p.cursor) return p;
            return {
              ...p,
              files: [...p.files, ...more.value.files],
              cursor: more.value.cursor,
            };
          });
          return { ...prev, pages };
        });
      })
      .finally(() => setLoadingMore(false));
  }, [current, loadingMore]);

  const reload = useCallback(() => setRun((n) => n + 1), []);

  const removeFile = useCallback((file: FileSummary) => {
    setLoaded((prev) => {
      if (!prev) return prev;
      let changed = false;
      const pages = prev.pages.map((p) => {
        if (file.library_id && p.libraryId !== file.library_id) return p;
        const { files, cursor, removed } = without(p.files, p.cursor, file);
        if (!removed) return p;
        changed = true;
        return { ...p, files, cursor, total: Math.max(0, p.total - 1) };
      });
      return changed ? { ...prev, pages } : prev;
    });
  }, []);

  // Search has no meaningful global order (each library returns its own
  // relevance or id order), so a searching listing keeps its per-library
  // concatenation instead of the date/name weave below.
  const searching = usesSearch(query);

  const files = useMemo(() => {
    if (!current) return EMPTY_FILES;
    const list = current.pages.map((p) => p.files);
    if (searching) return list.flat();
    if (list.length <= 1) return list[0] ?? EMPTY_FILES;
    return interleave(list, compareFor(query.sort, query.order));
  }, [current, searching, query.sort, query.order]);
  const folders = useMemo(() => {
    if (!current) return EMPTY_FOLDERS;
    const merged = current.pages
      .flatMap((p) => p.folders)
      .filter((f): f is Folder => Boolean(f.library_id));
    return [...merged].sort((a, b) => a.name.localeCompare(b.name));
  }, [current]);

  return {
    files,
    folders,
    total: current?.pages.reduce((sum, p) => sum + p.total, 0) ?? 0,
    loading: key !== null && current === null,
    error: current?.error ?? null,
    hasMore: Boolean(current?.pages.some((p) => p.cursor)),
    loadingMore,
    loadMore,
    reload,
    removeFile,
    searching,
  };
}
