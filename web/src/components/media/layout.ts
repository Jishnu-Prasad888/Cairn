/**
 * The media grid's geometry, as pure functions.
 *
 * A grid of a hundred thousand photos cannot mount a hundred thousand images,
 * so the grid is laid out as a list of rows with known heights — date headers
 * and rows of square tiles — and only the rows inside the viewport are
 * rendered. Everything here is arithmetic over that list, which keeps it fast
 * (no DOM measurement per tile) and testable without a browser.
 */

import type { FileSummary } from '../../api/types';
import { BREAKPOINTS } from '../../lib/breakpoints';
import {
  dayKey,
  formatDayHeading,
  formatMonthHeading,
  formatWeekHeading,
  formatYearHeading,
  monthKey,
  weekKey,
  yearKey,
} from '../../lib/dates';

/** How wide a slice of time one date heading (or timeline tick) covers. */
export type TimeScale = 'day' | 'week' | 'month' | 'year';

export type Grouping = TimeScale | 'none';

/** Finest to coarsest: the order the timeline's zoom buttons step through. */
export const TIME_SCALES: readonly TimeScale[] = ['day', 'week', 'month', 'year'];

const KEY_OF: Record<TimeScale, (iso: string) => string> = {
  day: dayKey,
  week: weekKey,
  month: monthKey,
  year: yearKey,
};

const LABEL_OF: Record<TimeScale, (key: string, now: Date) => string> = {
  day: formatDayHeading,
  week: formatWeekHeading,
  month: formatMonthHeading,
  year: formatYearHeading,
};

/** The key of the `scale`-wide slice `iso` falls in, or `''` when undated. */
export function sliceKey(scale: TimeScale, iso: string): string {
  return KEY_OF[scale](iso);
}

/** `scale`, or `coarsest` if it is coarser than that. */
export function clampScale(scale: TimeScale, coarsest: TimeScale): TimeScale {
  return TIME_SCALES.indexOf(scale) > TIME_SCALES.indexOf(coarsest) ? coarsest : scale;
}

/**
 * The coarsest scale that still splits `files` into more than one slice:
 * zooming out past it would just put everything under one heading. Only the
 * earliest and latest dates matter — if they fall in different years there
 * are at least two year slices, and so on down.
 */
export function coarsestScale(files: readonly FileSummary[]): TimeScale {
  let min = '';
  let max = '';
  for (const file of files) {
    const key = dayKey(file.mod_time);
    if (!key) continue;
    if (!min || key < min) min = key;
    if (!max || key > max) max = key;
  }
  if (!min) return 'day';
  const iso = (key: string) => `${key}T12:00:00`;
  for (let i = TIME_SCALES.length - 1; i > 0; i--) {
    const scale = TIME_SCALES[i]!;
    if (sliceKey(scale, iso(min)) !== sliceKey(scale, iso(max))) return scale;
  }
  return 'day';
}

export interface MediaGroup {
  key: string;
  /** Empty for an ungrouped grid. */
  label: string;
  items: FileSummary[];
  /** Index of the group's first item in the flat file list. */
  startIndex: number;
}

/**
 * Split an already-sorted list into runs that share a calendar day, week,
 * month or year.
 * Order is preserved: a group is a contiguous run, so a list sorted by name
 * would produce many small groups — callers only group date-sorted lists.
 */
export function groupFiles(
  files: readonly FileSummary[],
  grouping: Grouping,
  now: Date = new Date(),
): MediaGroup[] {
  if (grouping === 'none') {
    return files.length === 0 ? [] : [{ key: 'all', label: '', items: [...files], startIndex: 0 }];
  }
  const keyOf = KEY_OF[grouping];
  const labelOf = LABEL_OF[grouping];
  const groups: MediaGroup[] = [];
  let current: MediaGroup | null = null;
  files.forEach((file, index) => {
    const key = keyOf(file.mod_time) || 'undated';
    if (!current || current.key !== key) {
      current = { key, label: labelOf(key, now), items: [], startIndex: index };
      groups.push(current);
    }
    current.items.push(file);
  });
  return groups;
}

export interface GridMetrics {
  columns: number;
  /** Side of a square tile in px. */
  tileSize: number;
  gap: number;
}

/** The tile size a grid aims for at a given container width. */
export function targetTileSize(width: number): number {
  // Four across a typical phone, the way a camera roll reads.
  if (width < BREAKPOINTS.compact) return 88;
  if (width < BREAKPOINTS.medium) return 128;
  return 150;
}

/**
 * Zooming the grid (pinch, Ctrl + wheel, Ctrl + plus/minus) steps through these
 * multipliers of the target tile size: bigger tiles (fewer columns) at the
 * start, smaller at the end. `DEFAULT_DENSITY` is the 1x step.
 */
export const GRID_DENSITIES = [2.2, 1.8, 1.5, 1.25, 1, 0.82, 0.68, 0.56, 0.46] as const;
export const DEFAULT_DENSITY = 4;

/**
 * How many square tiles fit across `width`, and how big each one is so the row
 * fills the width exactly. Never fewer than three columns on a phone, because a
 * photo grid of two is a list.
 */
export function gridMetrics(
  width: number,
  gap: number,
  target = targetTileSize(width),
): GridMetrics {
  const usable = Math.max(width, 1);
  const minColumns = 3;
  const columns = Math.max(minColumns, Math.floor((usable + gap) / (target + gap)));
  const tileSize = Math.max(1, (usable - gap * (columns - 1)) / columns);
  return { columns, tileSize, gap };
}

export type GridRow =
  | { kind: 'header'; key: string; label: string; top: number; height: number }
  | {
      kind: 'tiles';
      key: string;
      top: number;
      height: number;
      items: FileSummary[];
      /** Flat index of the row's first item. */
      startIndex: number;
    };

export interface GridLayout {
  rows: GridRow[];
  totalHeight: number;
  metrics: GridMetrics;
  /** For each flat item index, the index of the row that holds it. */
  rowOfItem: Int32Array;
}

export const HEADER_HEIGHT = 52;
export const FIRST_HEADER_HEIGHT = 40;

/** Lay groups out as rows. */
export function layoutGrid(groups: readonly MediaGroup[], metrics: GridMetrics): GridLayout {
  const rows: GridRow[] = [];
  const itemCount = groups.reduce((n, g) => n + g.items.length, 0);
  const rowOfItem = new Int32Array(itemCount);
  const rowHeight = metrics.tileSize + metrics.gap;
  let top = 0;

  groups.forEach((group, groupIndex) => {
    if (group.label) {
      const height = groupIndex === 0 ? FIRST_HEADER_HEIGHT : HEADER_HEIGHT;
      rows.push({ kind: 'header', key: `h:${group.key}`, label: group.label, top, height });
      top += height;
    }
    for (let i = 0; i < group.items.length; i += metrics.columns) {
      const items = group.items.slice(i, i + metrics.columns);
      const startIndex = group.startIndex + i;
      const rowIndex = rows.length;
      for (let j = 0; j < items.length; j++) rowOfItem[startIndex + j] = rowIndex;
      rows.push({
        kind: 'tiles',
        key: `r:${group.key}:${i}`,
        top,
        height: rowHeight,
        items,
        startIndex,
      });
      top += rowHeight;
    }
  });

  return { rows, totalHeight: top, metrics, rowOfItem };
}

/**
 * The rows that intersect `[viewTop, viewBottom]`, widened by `overscan` px on
 * both sides so a fast scroll does not flash empty space. Binary search, so the
 * cost does not grow with the library.
 *
 * Generic over anything laid out as a `top`/`height` sequence sorted ascending
 * by `top` — the square grid's rows, or one column of the masonry grid.
 */
export function visibleRows<T extends { top: number; height: number }>(
  rows: readonly T[],
  viewTop: number,
  viewBottom: number,
  overscan: number,
): [number, number] {
  if (rows.length === 0) return [0, -1];
  const top = viewTop - overscan;
  const bottom = viewBottom + overscan;

  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const row = rows[mid]!;
    if (row.top + row.height <= top) lo = mid + 1;
    else hi = mid;
  }
  const first = lo;

  let last = first;
  while (last + 1 < rows.length && rows[last + 1]!.top < bottom) last += 1;
  return [first, last];
}

/**
 * Where keyboard focus lands after an arrow key, in a grid that wraps within
 * date groups. Left/right step through the flat list; up/down move to the
 * nearest item in the previous/next tile row, keeping the column where the row
 * is long enough.
 */
export function moveFocus(
  layout: GridLayout,
  index: number,
  key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End',
): number {
  const count = layout.rowOfItem.length;
  if (count === 0) return -1;
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, index - 1);
    case 'ArrowRight':
      return Math.min(count - 1, index + 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      break;
  }
  const rowIndex = layout.rowOfItem[index] ?? 0;
  const row = layout.rows[rowIndex];
  if (!row || row.kind !== 'tiles') return index;
  const column = index - row.startIndex;
  const step = key === 'ArrowUp' ? -1 : 1;
  for (let r = rowIndex + step; r >= 0 && r < layout.rows.length; r += step) {
    const candidate = layout.rows[r]!;
    if (candidate.kind !== 'tiles') continue;
    return candidate.startIndex + Math.min(column, candidate.items.length - 1);
  }
  return index;
}
