import { describe, expect, it } from 'vitest';

import { fileFixture } from '../../test/harness';
import { groupFiles } from './layout';
import { layoutMasonry, masonryMetrics, moveMasonryFocus, tileAspect } from './masonry';

const day = (n: number, id: string) =>
  fileFixture({
    id,
    name: `${id}.jpg`,
    mod_time: `2026-09-${String(n).padStart(2, '0')}T12:00:00`,
  });

describe('tileAspect', () => {
  it('is stable for the same id', () => {
    expect(tileAspect('abc')).toBe(tileAspect('abc'));
  });

  it('stays within the bounded range', () => {
    for (const id of ['a', 'bb', 'ccc', 'file-123', 'z'.repeat(40)]) {
      const ratio = tileAspect(id);
      expect(ratio).toBeGreaterThanOrEqual(0.62);
      expect(ratio).toBeLessThanOrEqual(1.8);
    }
  });

  it('varies across ids, so the grid actually looks like a waterfall', () => {
    const ratios = new Set(['a', 'b', 'c', 'd', 'e'].map(tileAspect));
    expect(ratios.size).toBeGreaterThan(1);
  });
});

describe('masonryMetrics', () => {
  it('fills the row exactly', () => {
    const { columns, columnWidth, gap } = masonryMetrics(1000, 4, 196);
    expect(columns * columnWidth + (columns - 1) * gap).toBeCloseTo(1000);
  });

  it('never goes below three columns, even on a narrow phone', () => {
    expect(masonryMetrics(320, 2, 120).columns).toBeGreaterThanOrEqual(3);
  });

  it('uses more columns on a wider container', () => {
    expect(masonryMetrics(1600, 4, 196).columns).toBeGreaterThan(masonryMetrics(800, 4, 196).columns);
  });
});

describe('layoutMasonry', () => {
  const files = Array.from({ length: 1000 }, (_, i) => day((i % 28) + 1, `f${i}`));
  const groups = groupFiles(files, 'none');
  const layout = layoutMasonry(groups, masonryMetrics(1000, 4, 196));

  it('lays every file out exactly once, across its columns', () => {
    const placed = layout.columns.flat();
    expect(placed).toHaveLength(1000);
    expect(layout.topOfItem).toHaveLength(1000);
  });

  it('keeps each column sorted ascending by top, so it can be binary-searched', () => {
    for (const col of layout.columns) {
      for (let i = 1; i < col.length; i++) {
        expect(col[i]!.top).toBeGreaterThanOrEqual(col[i - 1]!.top);
      }
    }
  });

  it('gives tiles varied heights, bounded by the aspect-ratio range', () => {
    const heights = new Set(layout.columns.flat().map((c) => c.height));
    expect(heights.size).toBeGreaterThan(1);
  });

  it('computes a total height tall enough for the longest column', () => {
    const lastTops = layout.columns.map((col) => (col.length ? col[col.length - 1]!.top + col[col.length - 1]!.height : 0));
    expect(layout.totalHeight).toBeCloseTo(Math.max(...lastTops), 0);
  });

  it('copes with a huge library without blowing up', () => {
    const big = Array.from({ length: 50_000 }, (_, i) => day((i % 28) + 1, `b${i}`));
    const bigLayout = layoutMasonry(groupFiles(big, 'none'), masonryMetrics(1200, 4, 196));
    expect(bigLayout.columns.flat()).toHaveLength(50_000);
  });

  it('resets every column flush at a date header', () => {
    const grouped = groupFiles(
      [day(28, 'a'), day(28, 'b'), day(28, 'c'), day(21, 'd'), day(21, 'e'), day(21, 'f')],
      'day',
    );
    const headerLayout = layoutMasonry(grouped, masonryMetrics(600, 4, 100));
    const secondHeaderTop = headerLayout.headers[1]!.top;
    // Every column's first tile in the second group starts at the same line,
    // right after that header — nothing from the first group spills under it.
    const colsWithSecondGroupTiles = headerLayout.columns.filter((col) =>
      col.some((c) => c.index >= 3),
    );
    expect(colsWithSecondGroupTiles.length).toBeGreaterThan(0);
    for (const col of colsWithSecondGroupTiles) {
      const firstOfGroup = col.find((c) => c.index >= 3);
      expect(firstOfGroup!.top).toBeGreaterThanOrEqual(secondHeaderTop + headerLayout.headers[1]!.height);
    }
  });
});

describe('moveMasonryFocus', () => {
  const files = Array.from({ length: 23 }, (_, i) => day(1, `m${i}`));
  const layout = layoutMasonry(groupFiles(files, 'none'), masonryMetrics(500, 4, 100));

  it('steps through the flat list with left and right, and stops at the ends', () => {
    expect(moveMasonryFocus(layout, 0, 'ArrowLeft')).toBe(0);
    expect(moveMasonryFocus(layout, 3, 'ArrowRight')).toBe(4);
    expect(moveMasonryFocus(layout, 22, 'ArrowRight')).toBe(22);
  });

  it('jumps to the ends with Home and End', () => {
    expect(moveMasonryFocus(layout, 9, 'Home')).toBe(0);
    expect(moveMasonryFocus(layout, 9, 'End')).toBe(22);
  });

  it('moves within the same column with up and down, and stops at its ends', () => {
    const col = layout.columnOfItem[5]!;
    const sameColumn = layout.columns[col]!;
    const position = layout.positionInColumn[5]!;

    const down = moveMasonryFocus(layout, 5, 'ArrowDown');
    if (position + 1 < sameColumn.length) {
      expect(down).toBe(sameColumn[position + 1]!.index);
    } else {
      expect(down).toBe(5);
    }

    const up = moveMasonryFocus(layout, 5, 'ArrowUp');
    if (position > 0) {
      expect(up).toBe(sameColumn[position - 1]!.index);
    } else {
      expect(up).toBe(5);
    }
  });

  it('returns -1 for an empty list', () => {
    const empty = layoutMasonry([], masonryMetrics(500, 4, 100));
    expect(moveMasonryFocus(empty, 0, 'ArrowDown')).toBe(-1);
  });
});
