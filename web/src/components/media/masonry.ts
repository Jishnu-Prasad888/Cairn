/**
 * The masonry layout used by the Photos page: a waterfall of tiles, columns
 * filling independently, Unsplash-style — most tiles a touch wider or taller
 * than the next, none too thin or too tall. Cairn doesn't have every photo's
 * real dimensions in bulk, so the shape is a stable pseudo-random pick per
 * file id (bounded, and always the same for that photo) rather than its true
 * aspect ratio.
 *
 * Virtualization stays cheap the same way the square grid's does: each column
 * is its own ascending `top` sequence, so `visibleRows` can binary-search it
 * directly. Date headers reset every column to the same line, so a day's
 * photos never straddle it and the header search stays a simple ascending
 * sequence too.
 */

import type { FileSummary } from '../../api/types';
import { FIRST_HEADER_HEIGHT, HEADER_HEIGHT, type MediaGroup } from './layout';

/** Shortest tile: a wide landscape. Tallest: a narrow portrait. */
const MIN_ASPECT = 0.62;
const MAX_ASPECT = 1.8;

/**
 * A stable pseudo-random width/height ratio for a tile, derived from the
 * file's id (FNV-1a) so a photo is always the same size and the grid never
 * reshuffles itself between loads or pages.
 */
export function tileAspect(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const unit = (hash >>> 0) / 0xffffffff;
  return MIN_ASPECT + unit * (MAX_ASPECT - MIN_ASPECT);
}

export interface MasonryMetrics {
  columns: number;
  columnWidth: number;
  gap: number;
}

/**
 * How many columns fit across `width`, and how wide each one is so the
 * columns fill the width exactly. Never fewer than three, for the same reason
 * the square grid holds that floor: a photo grid of two reads as a list.
 */
export function masonryMetrics(width: number, gap: number, target: number): MasonryMetrics {
  const usable = Math.max(width, 1);
  const minColumns = 3;
  const columns = Math.max(minColumns, Math.floor((usable + gap) / (target + gap)));
  const columnWidth = Math.max(1, (usable - gap * (columns - 1)) / columns);
  return { columns, columnWidth, gap };
}

export type MasonryCell =
  | { kind: 'header'; key: string; label: string; top: number; height: number }
  | {
      kind: 'tile';
      key: string;
      top: number;
      height: number;
      left: number;
      width: number;
      column: number;
      file: FileSummary;
      index: number;
    };

type HeaderCell = Extract<MasonryCell, { kind: 'header' }>;
type TileCell = Extract<MasonryCell, { kind: 'tile' }>;

export interface MasonryLayout {
  /** One ascending-by-top sequence per column, for `visibleRows` to search. */
  columns: TileCell[][];
  /** Ascending by top. */
  headers: HeaderCell[];
  totalHeight: number;
  metrics: MasonryMetrics;
  /** For each flat item index, where it landed. */
  topOfItem: Float64Array;
  columnOfItem: Int32Array;
  /** Its position within `columns[columnOfItem[index]]`, for arrow-key nav. */
  positionInColumn: Int32Array;
}

/** Lay groups out as a column waterfall. */
export function layoutMasonry(
  groups: readonly MediaGroup[],
  metrics: MasonryMetrics,
): MasonryLayout {
  const { columns: columnCount, columnWidth, gap } = metrics;
  const columns: TileCell[][] = Array.from({ length: columnCount }, () => []);
  const colBottoms = new Array<number>(columnCount).fill(0);
  const headers: HeaderCell[] = [];
  const itemCount = groups.reduce((n, g) => n + g.items.length, 0);
  const topOfItem = new Float64Array(itemCount);
  const columnOfItem = new Int32Array(itemCount);
  const positionInColumn = new Int32Array(itemCount);
  let top = 0;

  groups.forEach((group, groupIndex) => {
    if (group.label) {
      const height = groupIndex === 0 ? FIRST_HEADER_HEIGHT : HEADER_HEIGHT;
      headers.push({ kind: 'header', key: `h:${group.key}`, label: group.label, top, height });
      top += height;
      colBottoms.fill(top);
    }

    group.items.forEach((file, i) => {
      const flatIndex = group.startIndex + i;
      let col = 0;
      for (let c = 1; c < columnCount; c++) {
        if (colBottoms[c]! < colBottoms[col]!) col = c;
      }
      const cellTop = colBottoms[col]!;
      const height = Math.max(1, columnWidth / tileAspect(file.id));
      const position = columns[col]!.length;
      columns[col]!.push({
        kind: 'tile',
        key: file.id,
        top: cellTop,
        height,
        left: col * (columnWidth + gap),
        width: columnWidth,
        column: col,
        file,
        index: flatIndex,
      });
      colBottoms[col] = cellTop + height + gap;
      topOfItem[flatIndex] = cellTop;
      columnOfItem[flatIndex] = col;
      positionInColumn[flatIndex] = position;
    });

    if (group.items.length > 0) top = Math.max(...colBottoms) - gap;
  });

  return {
    columns,
    headers,
    totalHeight: Math.max(top, 0),
    metrics,
    topOfItem,
    columnOfItem,
    positionInColumn,
  };
}

/**
 * Where keyboard focus lands after an arrow key. Left/right and Home/End step
 * through the flat (chronological) list, same as the square grid. Up/down
 * move within the tile's own column — a masonry column is the one place in
 * this layout that is still a simple ascending sequence.
 */
export function moveMasonryFocus(
  layout: MasonryLayout,
  index: number,
  key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End',
): number {
  const count = layout.topOfItem.length;
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
  const col = layout.columnOfItem[index] ?? 0;
  const position = layout.positionInColumn[index] ?? 0;
  const cells = layout.columns[col];
  if (!cells) return index;
  const step = key === 'ArrowUp' ? -1 : 1;
  const next = cells[position + step];
  return next ? next.index : index;
}
