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
  /** Whether this listing went through search (no sort order). */
  searching: boolean;
}

export function usesSearch(query: ListingQuery): boolean {
  return Boolean(
    query.q.trim() ||
    query.person ||
    query.album ||
    query.tag ||
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

interface Loaded {
  key: string;
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
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const key =
    enabled && libraryId ? `${libraryId}|${JSON.stringify(query)}|${run}|${refreshKey}` : null;
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  });

  useEffect(() => {
    if (key === null || libraryId === null) return;
    let cancelled = false;
    const current = queryRef.current;
    const wantFolders = current.withFolders && !usesSearch(current);
    Promise.all([
      wantFolders
        ? listFolders(libraryId, current.folder || undefined)
            .then((r) => r.folders ?? [])
            .catch(() => [] as Folder[])
        : Promise.resolve([] as Folder[]),
      fetchPage(libraryId, current),
    ])
      .then(([folders, page]) => {
        if (cancelled) return;
        setLoaded({
          key,
          folders,
          files: filterType(page.files ?? [], current.type),
          total: page.total ?? page.files?.length ?? 0,
          cursor: page.next_cursor || undefined,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoaded({
          key,
          folders: [],
          files: [],
          total: 0,
          cursor: undefined,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [key, libraryId, changeTick]);

  const current = loaded && loaded.key === key ? loaded : null;

  const loadMore = useCallback(() => {
    if (!libraryId || !current?.cursor || loadingMore) return;
    const pageKey = current.key;
    setLoadingMore(true);
    fetchPage(libraryId, queryRef.current, current.cursor)
      .then((page) => {
        setLoaded((prev) =>
          prev && prev.key === pageKey
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
          prev && prev.key === pageKey
            ? { ...prev, error: error instanceof Error ? error.message : String(error) }
            : prev,
        );
      })
      .finally(() => setLoadingMore(false));
  }, [libraryId, current, loadingMore]);

  const reload = useCallback(() => setRun((n) => n + 1), []);

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
    searching: usesSearch(query),
  };
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

type AggregatedLoaded = { key: string; pages: LibraryPage[]; error: string | null } | null;

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
  const [loaded, setLoaded] = useState<AggregatedLoaded>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const idsKey = libraryIds.join(',');
  const key = enabled && idsKey ? `${idsKey}|${JSON.stringify(query)}|${run}|${refreshKey}` : null;
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  });
  const idsRef = useRef(libraryIds);
  useEffect(() => {
    idsRef.current = libraryIds;
  });

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    const current = queryRef.current;
    const ids = idsRef.current;
    if (ids.length === 0) return;
    const wantFolders = current.withFolders && !usesSearch(current);

    Promise.allSettled(
      ids.map((libraryId) =>
        Promise.all([
          wantFolders
            ? listFolders(libraryId, current.folder || undefined)
                .then((r) => r.folders ?? [])
                .catch(() => [] as Folder[])
            : Promise.resolve([] as Folder[]),
          fetchPage(libraryId, current),
        ]).then(([folders, page]) => {
          const tag = (f: FileSummary): FileSummary => ({ ...f, library_id: libraryId });
          const tagFolder = (folder: Folder): Folder => ({ ...folder, library_id: libraryId });
          return {
            libraryId,
            folders: folders.map(tagFolder),
            files: filterType(page.files ?? [], current.type).map(tag),
            total: page.total ?? page.files?.length ?? 0,
            cursor: page.next_cursor || undefined,
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
      setLoaded({ key, pages, error: anyOk ? null : firstError });
    });
    return () => {
      cancelled = true;
    };
  }, [key, changeTick]);

  const current = loaded && loaded.key === key ? loaded : null;

  const loadMore = useCallback(() => {
    if (!current || loadingMore) return;
    const stale = current.key;
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
          if (!prev || prev.key !== stale) return prev;
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
          return { key: prev.key, pages, error: prev.error };
        });
      })
      .finally(() => setLoadingMore(false));
  }, [current, loadingMore]);

  const reload = useCallback(() => setRun((n) => n + 1), []);

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
    searching,
  };
}
