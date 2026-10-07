/**
 * The media grid: Cairn's main surface.
 *
 * Square thumbnails edge to edge, optionally grouped under quiet date headings,
 * with selection, keyboard navigation, and infinite scroll. Only the rows near
 * the viewport are mounted (see `layout.ts`), so the cost of a page does not
 * grow with the size of the library — a hundred thousand loaded items still
 * render a few dozen tiles.
 *
 * The window is the scroll container. That keeps one natural scrollbar for the
 * whole page instead of a grid scrolling inside a page that also scrolls.
 */

import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { FileSummary } from '../../api/types';
import { MediaTile } from './MediaTile';
import {
  type Grouping,
  type GridLayout,
  groupFiles,
  gridMetrics,
  layoutGrid,
  moveFocus,
  targetTileSize,
  visibleRows,
} from './layout';
import { type MasonryLayout, layoutMasonry, masonryMetrics, moveMasonryFocus } from './masonry';
import type { Selection } from './useSelection';
import './MediaGrid.css';

/** Either geometry the grid can lay files out with: the square grid shared by
 * Files/Videos/Search, or the Photos page's masonry waterfall. Kept as one
 * tagged value (rather than two parallel variables) so the rest of the
 * component can't read one kind's layout while the other is active. */
type Layout = { kind: 'square'; layout: GridLayout } | { kind: 'masonry'; layout: MasonryLayout };

/** The on-screen top/height of one tile, however its layout kind places it —
 * what `focusTile` needs to scroll a tile into view before focusing it. */
function cellBounds(layout: Layout, index: number): { top: number; height: number } | undefined {
  if (layout.kind === 'square') {
    const rowIndex = layout.layout.rowOfItem[index];
    const row = rowIndex === undefined ? undefined : layout.layout.rows[rowIndex];
    return row ? { top: row.top, height: row.height } : undefined;
  }
  const col = layout.layout.columnOfItem[index];
  const position = layout.layout.positionInColumn[index];
  const cell = col === undefined || position === undefined ? undefined : layout.layout.columns[col]?.[position];
  return cell ? { top: cell.top, height: cell.height } : undefined;
}

/** Width assumed before the container has been measured (and in jsdom). */
const FALLBACK_WIDTH = 1024;
/** Rows rendered beyond the viewport, in px, so fast scrolling stays filled. */
const OVERSCAN = 800;
/** Start fetching the next page this far before the end. */
const PREFETCH_MARGIN = '1200px';

export interface MediaGridProps {
  libraryId: string;
  files: FileSummary[];
  /** Group under date headings. Only meaningful for a date-sorted list. */
  grouping?: Grouping;
  /** A column waterfall of varied tile sizes (Photos) instead of the uniform
   * square grid shared by the other media surfaces. */
  masonry?: boolean | undefined;
  onOpen: (file: FileSummary) => void;
  /** Omit to make the grid read-only (no selection circles). */
  selection?: Selection;
  favorites?: ReadonlySet<string>;
  /** Right-click or long-press menu for a single tile. */
  onContextMenu?: (file: FileSummary, x: number, y: number) => void;
  /** Infinite scroll: more pages exist and how to fetch the next. */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /** Accessible name for the grid region ("Photos", "Album: Summer"). */
  label: string;
  testId?: string;
}

export function MediaGrid({
  libraryId,
  files,
  grouping = 'none',
  masonry = false,
  onOpen,
  selection,
  favorites,
  onContextMenu,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  label,
  testId = 'media-grid',
}: MediaGridProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: 0, gap: 4 });
  const [range, setRange] = useState<[number, number]>([0, -1]);
  const [masonryRange, setMasonryRange] = useState<{
    headers: [number, number];
    columns: [number, number][];
  }>({ headers: [0, -1], columns: [] });
  const [focusIndex, setFocusIndex] = useState(0);
  const pendingFocus = useRef<number | null>(null);

  const groups = useMemo(() => groupFiles(files, grouping), [files, grouping]);
  const layout: Layout = useMemo(() => {
    const width = box.width || FALLBACK_WIDTH;
    if (masonry) {
      return { kind: 'masonry', layout: layoutMasonry(groups, masonryMetrics(width, box.gap, targetTileSize(width))) };
    }
    return { kind: 'square', layout: layoutGrid(groups, gridMetrics(width, box.gap)) };
  }, [groups, box, masonry]);

  // Scroll handlers read the latest layout through a ref, synced before the
  // range is recomputed below.
  const layoutRef = useRef(layout);
  useLayoutEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  // Track the container's width; tiles resize to fill each row exactly.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const width = Math.round(el.getBoundingClientRect().width);
      const gap = readGap(el);
      setBox((prev) => (prev.width === width && prev.gap === gap ? prev : { width, gap }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Work out which rows are on screen. Runs on scroll (throttled to frames)
  // and whenever the layout changes; state only changes when the visible
  // window actually moves to a different set of rows.
  const updateRange = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const viewTop = -el.getBoundingClientRect().top;
    const viewBottom = viewTop + window.innerHeight;
    const current = layoutRef.current;
    if (current.kind === 'square') {
      const next = visibleRows(current.layout.rows, viewTop, viewBottom, OVERSCAN);
      setRange((prev) => (prev[0] === next[0] && prev[1] === next[1] ? prev : next));
      return;
    }
    const headers = visibleRows(current.layout.headers, viewTop, viewBottom, OVERSCAN);
    const columns = current.layout.columns.map((col) => visibleRows(col, viewTop, viewBottom, OVERSCAN));
    setMasonryRange((prev) =>
      prev.headers[0] === headers[0] &&
      prev.headers[1] === headers[1] &&
      prev.columns.length === columns.length &&
      prev.columns.every((p, i) => p[0] === columns[i]![0] && p[1] === columns[i]![1])
        ? prev
        : { headers, columns },
    );
  }, []);

  useLayoutEffect(updateRange, [layout, updateRange]);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateRange();
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [updateRange]);

  // Infinite scroll: ask for the next page as the end comes into view.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || !onLoadMore || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { rootMargin: PREFETCH_MARGIN },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, onLoadMore, files.length]);

  // Keep the roving tab stop on a file that still exists.
  const safeFocus = Math.min(focusIndex, Math.max(0, files.length - 1));

  // Move keyboard focus to a tile, scrolling it into view first if its row is
  // not mounted yet; focus is applied once the row has rendered.
  const focusTile = useCallback((index: number) => {
    const bounds = cellBounds(layoutRef.current, index);
    const el = containerRef.current;
    if (bounds && el) {
      const containerTop = el.getBoundingClientRect().top + window.scrollY;
      const rowTop = containerTop + bounds.top;
      const viewTop = window.scrollY + stickyOffset();
      const viewBottom = window.scrollY + window.innerHeight;
      if (rowTop < viewTop) {
        window.scrollTo({ top: rowTop - stickyOffset() - 8 });
      } else if (rowTop + bounds.height > viewBottom) {
        window.scrollTo({ top: rowTop + bounds.height - window.innerHeight + 8 });
      }
    }
    pendingFocus.current = index;
    setFocusIndex(index);
  }, []);

  useEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    const button = containerRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (button) {
      pendingFocus.current = null;
      button.focus({ preventScroll: true });
    }
  });

  const selectable = selection !== undefined;
  const selecting = selection?.active ?? false;

  const onActivate = useCallback(
    (file: FileSummary, _index: number, event: ReactMouseEvent) => {
      if (selection) {
        if (event.shiftKey) return selection.toggle(file, true);
        if (event.metaKey || event.ctrlKey) return selection.toggle(file);
        // Once something is selected, a click adds to the selection instead of
        // opening — the way every photo library behaves.
        if (selection.active) return selection.toggle(file);
      }
      onOpen(file);
    },
    [onOpen, selection],
  );

  const onToggleSelect = useCallback(
    (file: FileSummary, _index: number, range: boolean) => selection?.toggle(file, range),
    [selection],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (!target.matches('.media-tile-main')) return;
    const index = Number(target.dataset.index);
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown':
      case 'Home':
      case 'End': {
        event.preventDefault();
        const next =
          layout.kind === 'masonry'
            ? moveMasonryFocus(layout.layout, index, event.key)
            : moveFocus(layout.layout, index, event.key);
        if (next >= 0) focusTile(next);
        if (next >= files.length - layout.layout.metrics.columns && hasMore && !loadingMore)
          onLoadMore?.();
        return;
      }
      case ' ':
      case 'x':
        if (!selection) return;
        event.preventDefault();
        selection.toggle(files[index]!, event.shiftKey);
        return;
      case 'a':
        if (!selection || !(event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        selection.selectAll();
        return;
      default:
        return;
    }
  };

  let content: React.ReactNode;
  if (layout.kind === 'square') {
    const [first, last] = range;
    const visible = last >= first ? layout.layout.rows.slice(first, last + 1) : [];
    const { tileSize, gap } = layout.layout.metrics;
    content = visible.map((row) =>
      row.kind === 'header' ? (
        <h2
          key={row.key}
          className="media-date"
          style={{ transform: `translateY(${row.top}px)`, height: row.height }}
        >
          {row.label}
        </h2>
      ) : (
        <div
          key={row.key}
          className="media-row"
          style={{ transform: `translateY(${row.top}px)`, height: tileSize }}
        >
          {row.items.map((file, j) => {
            const index = row.startIndex + j;
            return (
              <MediaTile
                key={file.id}
                libraryId={libraryId}
                file={file}
                index={index}
                style={{ width: tileSize, height: tileSize, left: j * (tileSize + gap) }}
                selected={selection?.isSelected(file.id) ?? false}
                selectable={selectable}
                selecting={selecting}
                favorite={favorites?.has(file.id) ?? false}
                tabbable={index === safeFocus}
                onActivate={onActivate}
                onToggleSelect={onToggleSelect}
                onFocusTile={setFocusIndex}
                onContextMenu={onContextMenu}
              />
            );
          })}
        </div>
      ),
    );
  } else {
    const [hf, hl] = masonryRange.headers;
    const headerCells = hl >= hf ? layout.layout.headers.slice(hf, hl + 1) : [];
    const tileCells = layout.layout.columns.flatMap((col, i) => {
      const [cf, cl] = masonryRange.columns[i] ?? [0, -1];
      return cl >= cf ? col.slice(cf, cl + 1) : [];
    });
    content = (
      <>
        {headerCells.map((h) => (
          <h2
            key={h.key}
            className="media-date"
            style={{ transform: `translateY(${h.top}px)`, height: h.height }}
          >
            {h.label}
          </h2>
        ))}
        {tileCells.map((cell) => (
          <MediaTile
            key={cell.file.id}
            libraryId={libraryId}
            file={cell.file}
            index={cell.index}
            style={{ width: cell.width, height: cell.height, top: cell.top, left: cell.left }}
            selected={selection?.isSelected(cell.file.id) ?? false}
            selectable={selectable}
            selecting={selecting}
            favorite={favorites?.has(cell.file.id) ?? false}
            tabbable={cell.index === safeFocus}
            onActivate={onActivate}
            onToggleSelect={onToggleSelect}
            onFocusTile={setFocusIndex}
            onContextMenu={onContextMenu}
          />
        ))}
      </>
    );
  }

  return (
    <section className="media-grid-wrap" aria-label={label}>
      <div
        ref={containerRef}
        className={
          selecting
            ? `media-grid is-selecting${masonry ? ' is-masonry' : ''}`
            : `media-grid${masonry ? ' is-masonry' : ''}`
        }
        style={{ height: layout.layout.totalHeight }}
        onKeyDown={onKeyDown}
        data-testid={testId}
      >
        {content}
      </div>
      <div ref={sentinelRef} className="media-grid-sentinel" aria-hidden="true" />
      {hasMore && onLoadMore && (
        <div className="media-grid-more">
          <button
            type="button"
            className="button ghost-button"
            onClick={onLoadMore}
            disabled={loadingMore}
            data-testid="load-more"
          >
            {loadingMore ? 'Loading more…' : 'Load more'}
          </button>
        </div>
      )}
    </section>
  );
}

/** The gap between tiles, read from the `--media-gap` token. */
function readGap(el: HTMLElement): number {
  if (typeof getComputedStyle === 'undefined') return 4;
  const value = parseFloat(getComputedStyle(el).getPropertyValue('--media-gap'));
  return Number.isFinite(value) ? value : 4;
}

/** Height of the sticky top bar, so keyboard scrolling keeps tiles out from under it. */
function stickyOffset(): number {
  const bar = document.querySelector<HTMLElement>('[data-sticky-top]');
  return bar ? bar.getBoundingClientRect().height : 0;
}

/** Placeholder squares in the grid's own geometry, while the first page loads. */
export function MediaGridSkeleton({ count = 18 }: { count?: number }) {
  return (
    <div className="media-grid-skeleton" aria-hidden="true" data-testid="grid-skeleton">
      <div className="skeleton media-skeleton-heading" />
      <div className="media-skeleton-tiles">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="skeleton media-skeleton-tile" />
        ))}
      </div>
    </div>
  );
}
