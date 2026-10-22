/**
 * Grid thumbnails, fetched many at a time and kept on the device.
 *
 * Over plain http:// a browser holds about six connections to the server, and
 * a request per tile spends a full round trip on each: fine at home, slow over
 * a remote link or for a screen of tiny tiles. So the grid's photo tiles ask
 * this module instead, which:
 *
 * - **Loads what is on screen first.** Waiting tiles are served nearest the
 *   middle of the viewport first, and nothing is fetched while the page is
 *   being flung: the network waits until scrolling slows, so it is spent on
 *   where the person stops, not on everything they flew past.
 * - **Batches.** Up to `BATCH_MAX` thumbnails come back in one response
 *   (`GET /libraries/{id}/thumbnails`), so a screen is a few requests.
 * - **Keeps them.** Thumbnails are stored in IndexedDB keyed by the file's
 *   version, so a revisit — or a reload — draws from the device without asking
 *   the server at all. (The browser's HTTP cache cannot do this for batches.)
 *
 * A thumbnail the server has not made yet comes back "missing": the tile then
 * asks for that one on its own, which makes it. Any failure here does the
 * same, so batching can only ever make a tile faster, never break it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { FileSummary } from '../../api/types';
import { acquireSlot } from './thumbnailQueue';

export type ThumbSize = 'sm' | 'md';

/** Longest side, in device pixels, the small (256px) thumbnail covers well. */
const SMALL_MAX_PX = 320;
const BATCH_MAX = 48;
/** Batches in flight at once; single downloads keep the rest of the slots. */
const MAX_IN_FLIGHT = 2;
/** Thumbnails kept as object URLs in memory for instant re-display. */
const MEMORY_MAX = 4000;
/** Above this many stored thumbnails, the oldest are cleared down to `IDB_KEEP`. */
const IDB_MAX = 60000;
const IDB_KEEP = 45000;
/** Faster than this (px per ms) the page is being flung: hold the network. */
const FLING_SPEED = 2.5;
const SETTLE_MS = 120;

const API_BASE = '/api/v1';
const MAGIC = 'CTB1';

let enabled = true;

/** Turn batching off (tests, or a server without the batch endpoint). */
export function setThumbBatching(on: boolean) {
  enabled = on;
}

export function thumbBatchingEnabled(): boolean {
  return enabled && typeof fetch === 'function' && typeof Blob === 'function';
}

/** The size to ask for a tile drawn `cssPx` wide on this screen. */
export function thumbSizeFor(cssPx: number): ThumbSize {
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  return cssPx * dpr <= SMALL_MAX_PX ? 'sm' : 'md';
}

type Outcome = { url: string } | { missing: true };

interface Want {
  key: string;
  libraryId: string;
  fileId: string;
  size: ThumbSize;
  listeners: Set<(outcome: Outcome) => void>;
  elements: Set<{ current: HTMLElement | null }>;
}

const memory = new Map<string, string>();
const inUse = new Map<string, number>();
const missing = new Set<string>();
const pending = new Map<string, Want>();
const fetching = new Map<string, Want>();
let inFlight = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

export function thumbKey(libraryId: string, file: FileSummary, size: ThumbSize): string {
  return `${libraryId}/${file.id}/${size}/${file.mod_time}-${file.size_bytes}`;
}

// ------------------------------- scrolling --------------------------------

let watching = false;
let lastY = 0;
let lastAt = 0;
let speed = 0;

function watchScroll() {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  lastY = window.scrollY;
  lastAt = performance.now();
  window.addEventListener(
    'scroll',
    () => {
      const now = performance.now();
      const dt = Math.max(1, now - lastAt);
      speed = Math.abs(window.scrollY - lastY) / dt;
      lastY = window.scrollY;
      lastAt = now;
    },
    { passive: true },
  );
}

function flinging(): boolean {
  return speed > FLING_SPEED && performance.now() - lastAt < SETTLE_MS;
}

// -------------------------------- memory ----------------------------------

function remember(key: string, url: string) {
  memory.delete(key);
  memory.set(key, url);
  if (memory.size <= MEMORY_MAX) return;
  for (const [k, u] of memory) {
    if (memory.size <= MEMORY_MAX) break;
    if (inUse.get(k)) continue; // still on screen
    memory.delete(k);
    URL.revokeObjectURL(u);
  }
}

function hold(key: string) {
  inUse.set(key, (inUse.get(key) ?? 0) + 1);
}

function letGo(key: string) {
  const n = (inUse.get(key) ?? 1) - 1;
  if (n <= 0) inUse.delete(key);
  else inUse.set(key, n);
}

// ------------------------------- IndexedDB --------------------------------

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open('cairn-thumbs', 1);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore('thumbs', { keyPath: 'k' });
      store.createIndex('t', 't');
    };
    req.onsuccess = () => {
      const db = req.result;
      resolve(db);
      prune(db);
    };
    // Private windows and blocked storage: work from memory and the network.
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** Keep the store bounded: clear the oldest once it grows past `IDB_MAX`. */
function prune(db: IDBDatabase) {
  try {
    const tx = db.transaction('thumbs', 'readwrite');
    const store = tx.objectStore('thumbs');
    const count = store.count();
    count.onsuccess = () => {
      let extra = count.result - IDB_KEEP;
      if (count.result <= IDB_MAX || extra <= 0) return;
      const cursor = store.index('t').openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c || extra <= 0) return;
        c.delete();
        extra -= 1;
        c.continue();
      };
    };
  } catch {
    // Storage gone or full; nothing to prune.
  }
}

function idbGet(keys: string[]): Promise<Map<string, Blob>> {
  return openDb().then(
    (db) =>
      new Promise((resolve) => {
        const found = new Map<string, Blob>();
        if (!db) return resolve(found);
        try {
          const store = db.transaction('thumbs', 'readonly').objectStore('thumbs');
          let left = keys.length;
          for (const key of keys) {
            const req = store.get(key);
            const done = () => {
              left -= 1;
              if (left === 0) resolve(found);
            };
            req.onsuccess = () => {
              const row = req.result as { b?: Blob } | undefined;
              if (row?.b) found.set(key, row.b);
              done();
            };
            req.onerror = done;
          }
          if (keys.length === 0) resolve(found);
        } catch {
          resolve(found);
        }
      }),
  );
}

function idbPut(rows: Array<[string, Blob]>) {
  if (rows.length === 0) return;
  void openDb().then((db) => {
    if (!db) return;
    try {
      const store = db.transaction('thumbs', 'readwrite').objectStore('thumbs');
      const t = Date.now();
      for (const [k, b] of rows) store.put({ k, b, t });
    } catch {
      // Quota or a closed database: they are still in memory for this visit.
    }
  });
}

// -------------------------------- network ---------------------------------

/**
 * Split a batch response into each file's JPEG (or "missing"), by file id.
 * Throws on anything that is not a well-formed batch.
 */
export function parseThumbBatch(buffer: ArrayBuffer): Map<string, Blob | null> {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 8 || new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) {
    throw new Error('not a thumbnail batch');
  }
  const manifestLength = new DataView(buffer).getUint32(4);
  const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + manifestLength))) as {
    items: Array<{ id: string; size?: number; missing?: boolean }>;
  };
  const out = new Map<string, Blob | null>();
  let offset = 8 + manifestLength;
  for (const item of manifest.items) {
    if (item.missing || !item.size) {
      out.set(item.id, null);
      continue;
    }
    if (offset + item.size > bytes.length) throw new Error('truncated thumbnail batch');
    out.set(
      item.id,
      new Blob([bytes.subarray(offset, offset + item.size)], { type: 'image/jpeg' }),
    );
    offset += item.size;
  }
  return out;
}

/** How far a waiting tile is from the middle of the screen (lower = sooner). */
function distance(want: Want): number {
  const middle = typeof window === 'undefined' ? 0 : window.innerHeight / 2;
  let best = Infinity;
  for (const el of want.elements) {
    if (!el.current) continue;
    const rect = el.current.getBoundingClientRect();
    best = Math.min(best, Math.abs(rect.top + rect.height / 2 - middle));
  }
  return best;
}

function settle(want: Want, outcome: Outcome) {
  if ('url' in outcome) remember(want.key, outcome.url);
  else missing.add(want.key);
  for (const listener of want.listeners) listener(outcome);
}

function schedule(delay = 0) {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    pump();
  }, delay);
}

function pump() {
  while (inFlight < MAX_IN_FLIGHT && pending.size > 0) {
    // Nearest the middle of the screen first; a batch is one library and size.
    const ranked = [...pending.values()]
      .map((want) => ({ want, d: distance(want) }))
      .sort((a, b) => a.d - b.d);
    const lead = ranked[0]!.want;
    const batch = ranked
      .filter(({ want }) => want.libraryId === lead.libraryId && want.size === lead.size)
      .slice(0, BATCH_MAX)
      .map(({ want }) => want);
    for (const want of batch) {
      pending.delete(want.key);
      fetching.set(want.key, want);
    }
    inFlight += 1;
    void run(batch).finally(() => {
      inFlight -= 1;
      for (const want of batch) fetching.delete(want.key);
      if (pending.size > 0) schedule();
    });
  }
}

async function run(batch: Want[]) {
  // The device first: no network at all for anything seen before.
  const stored = await idbGet(batch.map((w) => w.key));
  const rest: Want[] = [];
  for (const want of batch) {
    const blob = stored.get(want.key);
    if (blob) settle(want, { url: URL.createObjectURL(blob) });
    else if (want.listeners.size > 0) rest.push(want);
  }
  if (rest.length === 0) return;

  // Hold the network while the page is flung; requeue and wait for it to slow.
  if (flinging()) {
    for (const want of rest) pending.set(want.key, want);
    schedule(SETTLE_MS);
    return;
  }

  const releaseSlot = await acquireSlot();
  try {
    const { libraryId, size } = rest[0]!;
    const ids = rest.map((w) => w.fileId).join(',');
    const res = await fetch(
      `${API_BASE}/libraries/${encodeURIComponent(libraryId)}/thumbnails?size=${size}&ids=${encodeURIComponent(ids)}`,
      { credentials: 'same-origin' },
    );
    if (!res.ok) throw new Error(`thumbnail batch: ${res.status}`);
    const parts = parseThumbBatch(await res.arrayBuffer());
    const toStore: Array<[string, Blob]> = [];
    for (const want of rest) {
      const blob = parts.get(want.fileId);
      if (blob) {
        toStore.push([want.key, blob]);
        settle(want, { url: URL.createObjectURL(blob) });
      } else {
        settle(want, { missing: true });
      }
    }
    idbPut(toStore);
  } catch {
    // An older server, a dropped connection: these tiles load one by one.
    for (const want of rest) settle(want, { missing: true });
  } finally {
    releaseSlot();
  }
}

function subscribe(
  key: string,
  libraryId: string,
  file: FileSummary,
  size: ThumbSize,
  element: { current: HTMLElement | null },
  listener: (outcome: Outcome) => void,
): () => void {
  watchScroll();
  let want = pending.get(key) ?? fetching.get(key);
  if (!want) {
    want = { key, libraryId, fileId: file.id, size, listeners: new Set(), elements: new Set() };
    pending.set(key, want);
    schedule();
  }
  const w = want;
  w.listeners.add(listener);
  w.elements.add(element);
  return () => {
    w.listeners.delete(listener);
    w.elements.delete(element);
    // Scrolled away before its turn: it leaves the line.
    if (w.listeners.size === 0) pending.delete(key);
  };
}

export interface BatchedThumb {
  /** The image to show, once it has arrived. */
  src: string | undefined;
  /** The batch could not supply it: load it on its own instead. */
  missing: boolean;
  /** Pass as the `<img>`'s ref, so the line knows where on screen it is. */
  attach: (el: HTMLElement | null) => void;
}

/**
 * A grid tile's thumbnail through the batcher. `active` false (not a photo,
 * or batching off) does nothing and reports missing, so the caller falls back.
 */
export function useBatchedThumb(
  libraryId: string,
  file: FileSummary,
  size: ThumbSize,
  active: boolean,
): BatchedThumb {
  const key = thumbKey(libraryId, file, size);
  const element = useRef<HTMLElement | null>(null);
  const [arrived, setArrived] = useState<{ key: string; outcome: Outcome } | null>(null);

  useEffect(() => {
    if (!active || memory.has(key) || missing.has(key)) return;
    return subscribe(key, libraryId, file, size, element, (outcome) =>
      setArrived({ key, outcome }),
    );
    // file is identified by the key; libraryId and size are part of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);

  // Keep an on-screen thumbnail from being evicted from memory.
  const shownUrl = active ? memory.get(key) : undefined;
  useEffect(() => {
    if (!shownUrl) return;
    hold(key);
    return () => letGo(key);
  }, [key, shownUrl]);

  // Stable, so React does not detach and re-attach the image every render.
  const attach = useCallback((el: HTMLElement | null) => {
    element.current = el;
  }, []);

  if (!active) return { src: undefined, missing: true, attach };
  const outcome = arrived?.key === key ? arrived.outcome : undefined;
  const src = memory.get(key) ?? (outcome && 'url' in outcome ? outcome.url : undefined);
  return {
    src,
    missing: missing.has(key) || (outcome !== undefined && 'missing' in outcome),
    attach,
  };
}

/** Test hook: forget everything held in memory and in line. */
export function resetThumbBatch() {
  for (const url of memory.values()) URL.revokeObjectURL(url);
  memory.clear();
  inUse.clear();
  missing.clear();
  pending.clear();
  fetching.clear();
  inFlight = 0;
  if (timer !== null) clearTimeout(timer);
  timer = null;
}
