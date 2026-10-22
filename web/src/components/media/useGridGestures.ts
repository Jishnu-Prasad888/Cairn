/**
 * The grid's zoom and touch gestures, the ones people know from a camera roll:
 *
 * - **Pinch** in or out to change how many photos fit across. The tile under
 *   the fingers stays put while the grid re-flows around it.
 * - **Ctrl + wheel** (and a trackpad pinch, which arrives the same way) and
 *   **Ctrl + plus / minus / 0** do the same on a desktop. They are taken from
 *   the browser, which would otherwise zoom the whole app, whenever a grid is
 *   on the page and no dialog or viewer has the keyboard.
 * - **Long-press, then drag** to select a run of photos. Sliding back undoes
 *   what the drag added; holding a finger near the top or bottom edge scrolls.
 *
 * Both need to stop the browser from scrolling or zooming the page, so the
 * container gets a non-passive `touchmove` listener that only acts while a
 * gesture is under way.
 */

import { type RefObject, useCallback, useContext, useEffect, useRef, useState } from 'react';

import type { FileSummary } from '../../api/types';
import { AuthContext } from '../../auth/authContext';
import { BREAKPOINTS } from '../../lib/breakpoints';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { DEFAULT_DENSITY, GRID_DENSITIES } from './layout';
import type { Selection } from './useSelection';

/**
 * The zoom is remembered per person and per kind of device: browser storage
 * already belongs to one device, the key adds who is signed in, and phone,
 * tablet and desktop widths each keep their own (narrowing a desktop window
 * must not overwrite the desktop's choice).
 */
const DENSITY_KEY = 'cairn.gridDensity.v2';

function densityKey(userId: string | undefined, device: string): string {
  return `${DENSITY_KEY}:${userId ?? 'anonymous'}:${device}`;
}
/** How much the fingers must spread or close before the grid steps once. */
const PINCH_STEP = 1.22;
/** Wheel travel (px) per zoom step: one mouse notch, or a short trackpad pinch. */
const WHEEL_STEP = 60;
/** A pause this long in the wheel starts a fresh gesture. */
const WHEEL_IDLE_MS = 220;
/** Within this distance of a screen edge, a drag-select scrolls the page. */
const EDGE_PX = 72;
/** The fastest the page scrolls during a drag-select, in px per frame. */
const EDGE_SPEED = 18;

function readDensity(key: string): number {
  try {
    const raw = localStorage.getItem(key);
    // Number(null) is 0, the largest step: no stored value means the default.
    const value = raw === null ? NaN : Number(raw);
    if (Number.isInteger(value) && value >= 0 && value < GRID_DENSITIES.length) return value;
  } catch {
    // No storage: use the default.
  }
  return DEFAULT_DENSITY;
}

function writeDensity(key: string, value: number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Not remembered; the grid still changes.
  }
}

/** Where the grid was pinched: the tile under the fingers and its screen top. */
export interface PinchAnchor {
  index: number;
  screenTop: number;
}

function tileIndexAt(container: HTMLElement, x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-index]');
  if (!el || !container.contains(el)) return null;
  const index = Number(el.dataset.index);
  return Number.isInteger(index) ? index : null;
}

/** The tile at (x, y) — or, over a gap or a heading, one just below it. */
function anchorAt(container: HTMLElement, x: number, y: number): PinchAnchor | null {
  for (const dy of [0, 24, 64, 128]) {
    const index = tileIndexAt(container, x, y + dy);
    if (index === null) continue;
    const tile = container.querySelector(`[data-index="${index}"]`);
    if (tile) return { index, screenTop: tile.getBoundingClientRect().top };
  }
  return null;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
}

export function useGridGestures({
  containerRef,
  files,
  selection,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  files: readonly FileSummary[];
  selection: Selection | undefined;
}) {
  // Not useAuth(): public share pages show a grid with nobody signed in.
  const userId = useContext(AuthContext)?.user?.id;
  const phone = useMediaQuery(`(max-width: ${BREAKPOINTS.compact - 1}px)`);
  const tablet = useMediaQuery(`(max-width: ${BREAKPOINTS.medium - 1}px)`);
  const key = densityKey(userId, phone ? 'phone' : tablet ? 'tablet' : 'desktop');
  const [stored, setStored] = useState(() => ({ key, value: readDensity(key) }));
  // Another person or another device class: load that one's zoom.
  if (stored.key !== key) setStored({ key, value: readDensity(key) });
  const density = stored.key === key ? stored.value : readDensity(key);
  // Read by MediaGrid after the re-layout a pinch causes, to keep the tile
  // under the fingers where it was.
  const pinchAnchor = useRef<PinchAnchor | null>(null);

  // The latest values, for listeners attached once.
  const latest = useRef({ files, selection, density, key });
  useEffect(() => {
    latest.current = { files, selection, density, key };
  });

  /**
   * Step the zoom by `delta` (negative: bigger tiles), keeping the tile at
   * (x, y) where it is on screen. Returns whether anything changed.
   */
  const zoomBy = useCallback(
    (delta: number, x: number, y: number): boolean => {
      const el = containerRef.current;
      const current = latest.current.density;
      const next = Math.min(GRID_DENSITIES.length - 1, Math.max(0, current + delta));
      if (!el || next === current) return false;
      pinchAnchor.current = anchorAt(el, x, y);
      const { key: storageKey } = latest.current;
      latest.current.density = next;
      writeDensity(storageKey, next);
      setStored({ key: storageKey, value: next });
      return true;
    },
    [containerRef],
  );

  const resetZoom = useCallback(
    (x: number, y: number) => zoomBy(DEFAULT_DENSITY - latest.current.density, x, y),
    [zoomBy],
  );

  // Desktop zoom: Ctrl/Cmd + wheel and Ctrl/Cmd + plus, minus, 0.
  useEffect(() => {
    // A dialog or the viewer owns these (the viewer zooms its photo).
    const blocked = () => document.querySelector('[aria-modal="true"]') !== null;
    let wheelTravel = 0;
    let wheelAt = 0;

    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.defaultPrevented || blocked()) return;
      const el = containerRef.current;
      if (!el || !el.isConnected) return;
      event.preventDefault();
      const now = performance.now();
      if (now - wheelAt > WHEEL_IDLE_MS) wheelTravel = 0;
      wheelAt = now;
      // Line- and page-based wheels report far smaller numbers than pixels.
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
      wheelTravel += event.deltaY * scale;
      if (Math.abs(wheelTravel) < WHEEL_STEP) return;
      // Wheel up (negative) zooms in: bigger tiles.
      const steps = Math.trunc(wheelTravel / WHEEL_STEP);
      wheelTravel -= steps * WHEEL_STEP;
      zoomBy(Math.sign(steps), event.clientX, event.clientY);
    };

    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.defaultPrevented) return;
      if (blocked() || isTyping(event.target)) return;
      const el = containerRef.current;
      if (!el || !el.isConnected) return;
      const x = window.innerWidth / 2;
      const y = window.innerHeight / 2;
      switch (event.key) {
        case '=':
        case '+':
          event.preventDefault();
          zoomBy(-1, x, y);
          return;
        case '-':
        case '_':
          event.preventDefault();
          zoomBy(1, x, y);
          return;
        case '0':
          event.preventDefault();
          resetZoom(x, y);
          return;
        default:
          return;
      }
    };

    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
  }, [containerRef, zoomBy, resetZoom]);

  const drag = useRef<{
    anchor: number;
    last: number;
    /** Selecting (true) or deselecting (false) the tiles dragged over. */
    on: boolean;
    base: ReadonlySet<string>;
    x: number;
    y: number;
    frame: number;
  } | null>(null);

  /** Apply the drag from its anchor to `index` on top of the selection it started from. */
  const applyDrag = useCallback((index: number) => {
    const d = drag.current;
    const { files: list, selection: sel } = latest.current;
    if (!d || !sel) return;
    d.last = index;
    const ids = new Set(d.base);
    const [lo, hi] = d.anchor < index ? [d.anchor, index] : [index, d.anchor];
    for (let i = lo; i <= hi; i++) {
      const id = list[i]?.id;
      if (!id) continue;
      if (d.on) ids.add(id);
      else ids.delete(id);
    }
    sel.replace(ids);
  }, []);

  const stopDrag = useCallback(() => {
    if (drag.current?.frame) cancelAnimationFrame(drag.current.frame);
    drag.current = null;
  }, []);

  /** A long-press on a tile: toggle it, and let the same finger drag on. */
  const onLongPress = useCallback(
    (file: FileSummary, index: number) => {
      const sel = latest.current.selection;
      if (!sel) return;
      stopDrag();
      drag.current = {
        anchor: index,
        last: index,
        on: !sel.isSelected(file.id),
        base: sel.selected,
        x: 0,
        y: 0,
        frame: 0,
      };
      applyDrag(index);
    },
    [applyDrag, stopDrag],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let pinch: { distance: number } | null = null;

    // While a finger rests near an edge, keep scrolling and keep extending.
    const edgeScroll = () => {
      const d = drag.current;
      if (!d) return;
      d.frame = 0;
      // The selection bar covers the bottom of the screen on phones.
      const bottomEdge = window.innerHeight - EDGE_PX - 56;
      let speed = 0;
      if (d.y < EDGE_PX) speed = -EDGE_SPEED * Math.min(1, (EDGE_PX - d.y) / EDGE_PX);
      else if (d.y > bottomEdge) speed = EDGE_SPEED * Math.min(1, (d.y - bottomEdge) / EDGE_PX);
      if (speed === 0) return;
      window.scrollBy(0, speed);
      const index = tileIndexAt(el, d.x, d.y);
      if (index !== null && index !== d.last) applyDrag(index);
      d.frame = requestAnimationFrame(edgeScroll);
    };

    const spread = (touches: TouchList) => {
      const a = touches[0]!;
      const b = touches[1]!;
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        stopDrag();
        pinch = { distance: spread(event.touches) };
      }
    };

    const onTouchMove = (event: TouchEvent) => {
      if (pinch && event.touches.length === 2) {
        if (event.cancelable) event.preventDefault();
        const distance = spread(event.touches);
        const ratio = distance / pinch.distance;
        // Spreading the fingers zooms in: bigger tiles, a lower index.
        const delta = ratio > PINCH_STEP ? -1 : ratio < 1 / PINCH_STEP ? 1 : 0;
        if (delta === 0) return;
        const a = event.touches[0]!;
        const b = event.touches[1]!;
        if (zoomBy(delta, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2)) {
          pinch = { distance };
        }
        return;
      }
      const d = drag.current;
      const touch = event.touches[0];
      if (!d || !touch) return;
      if (event.cancelable) event.preventDefault();
      d.x = touch.clientX;
      d.y = touch.clientY;
      const index = tileIndexAt(el, d.x, d.y);
      if (index !== null && index !== d.last) applyDrag(index);
      if (!d.frame) d.frame = requestAnimationFrame(edgeScroll);
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) pinch = null;
      if (event.touches.length === 0) stopDrag();
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      stopDrag();
    };
  }, [applyDrag, containerRef, stopDrag, zoomBy]);

  /** The anchor of the last pinch, once: the grid re-anchors its scroll to it. */
  const takePinchAnchor = useCallback(() => {
    const anchor = pinchAnchor.current;
    pinchAnchor.current = null;
    return anchor;
  }, []);

  return { density, takePinchAnchor, onLongPress: selection ? onLongPress : undefined };
}
