/**
 * At most a few thumbnails download at once.
 *
 * Over plain http:// a browser opens only about six connections to one
 * server. A grid that set every tile's `src` straight away could fill all six
 * with thumbnails the server still has to make (each one a full-size decode),
 * and then anything else — the next page's data, a click — queued behind
 * them: scroll a large, half-processed library, open Home, and the whole page
 * sat loading. Thumbnails here wait their turn instead, leave the queue when
 * their tile scrolls away, and cancel the download if they were mid-way, so
 * connections stay free for the app itself.
 *
 * A thumbnail already loaded in this tab skips the queue: it comes from the
 * browser cache.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** Leaves one of the browser's ~six connections for API requests. Batched
 * thumbnail requests (see `thumbBatch.ts`) take their turns from the same
 * budget, so the two never crowd out the app between them. */
const MAX_ACTIVE = 5;

const loaded = new Set<string>();
const waiting: Array<() => void> = [];
let active = 0;

function grantNext() {
  while (active < MAX_ACTIVE && waiting.length > 0) {
    active += 1;
    waiting.shift()!();
  }
}

function release() {
  active = Math.max(0, active - 1);
  grantNext();
}

/**
 * Wait for a download slot outside a component: resolves with the function
 * that gives it back (safe to call more than once).
 */
export function acquireSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    waiting.push(() => {
      let held = true;
      resolve(() => {
        if (!held) return;
        held = false;
        release();
      });
    });
    grantNext();
  });
}

/** Test hook: forget every slot and every loaded URL. */
export function resetThumbnailQueue() {
  loaded.clear();
  waiting.length = 0;
  active = 0;
}

export interface QueuedImage {
  /** The URL to give the `<img>`, once its turn has come. */
  src: string | undefined;
  /** Pass as the `<img>`'s ref, so an unmount can cancel its download. */
  attach: (img: HTMLImageElement | null) => void;
  /** Call from the image's `onLoad` / `onError`. */
  settle: (ok: boolean) => void;
}

export function useQueuedImage(url: string | undefined): QueuedImage {
  const [grantedFor, setGrantedFor] = useState<string | undefined>(undefined);
  const holding = useRef(false);
  const img = useRef<HTMLImageElement | null>(null);

  const giveBack = useCallback(() => {
    if (!holding.current) return;
    holding.current = false;
    release();
  }, []);

  useEffect(() => {
    if (url === undefined || loaded.has(url)) return;
    let cancelled = false;
    const grant = () => {
      if (cancelled) {
        release();
        return;
      }
      holding.current = true;
      setGrantedFor(url);
    };
    waiting.push(grant);
    grantNext();
    return () => {
      cancelled = true;
      const at = waiting.indexOf(grant);
      if (at >= 0) waiting.splice(at, 1);
      if (holding.current) {
        img.current?.removeAttribute('src');
        giveBack();
      }
    };
  }, [url, giveBack]);

  const settle = useCallback(
    (ok: boolean) => {
      if (ok && url !== undefined) loaded.add(url);
      giveBack();
    },
    [url, giveBack],
  );

  // React detaches the ref before running the effect cleanup on unmount, so
  // an unmount mid-download is caught here. Dropping the src makes the
  // browser abandon the download, which also lets the server stop waiting to
  // make this thumbnail.
  const attach = useCallback(
    (el: HTMLImageElement | null) => {
      if (el === null && img.current && holding.current) {
        img.current.removeAttribute('src');
        giveBack();
      }
      img.current = el;
    },
    [giveBack],
  );

  // Already loaded in this tab: straight from the cache, no turn needed.
  const ready = url !== undefined && (grantedFor === url || loaded.has(url));
  return { src: ready ? url : undefined, attach, settle };
}
