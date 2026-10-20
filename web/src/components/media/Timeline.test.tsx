import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { fileFixture } from '../../test/harness';
import { Timeline } from './Timeline';

/** A stand-in for the grid `Timeline` scrolls, with a fixed, known geometry. */
function Grid() {
  return <div data-testid="file-grid" style={{ height: 2000 }} />;
}

function mockGridRect() {
  const el = screen.getByTestId('file-grid');
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    top: 100,
    bottom: 2100,
    height: 2000,
    left: 0,
    right: 900,
    width: 900,
    x: 0,
    y: 100,
    toJSON: () => ({}),
  });
  return el;
}

function filesAcross(months: string[]): ReturnType<typeof fileFixture>[] {
  return months.map((m, i) => fileFixture({ id: `f${i}`, mod_time: `${m}-10T12:00:00` }));
}

describe('Timeline', () => {
  it('says so, rather than showing nothing, when everything falls in one month', () => {
    render(<Timeline files={filesAcross(['2026-09', '2026-09'])} label="Photos" />);
    expect(screen.getByTestId('timeline')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Sep 2026');
  });

  it('renders nothing with no files', () => {
    render(<Timeline files={[]} label="Photos" />);
    expect(screen.queryByTestId('timeline')).not.toBeInTheDocument();
  });

  it('marks a year tick once per year, not once per month', () => {
    render(
      <Timeline files={filesAcross(['2025-01', '2025-06', '2026-02', '2026-09'])} label="Photos" />,
    );
    expect(screen.getByText('2025')).toBeInTheDocument();
    expect(screen.getByText('2026')).toBeInTheDocument();
  });

  it('jumps the window when the track is clicked', () => {
    render(
      <>
        <Grid />
        <Timeline files={filesAcross(['2024-01', '2025-06', '2026-09'])} label="Photos" />
      </>,
    );
    mockGridRect();
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo;

    const track = screen.getByRole('slider', { name: 'Photos timeline' });
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 30,
      height: 30,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(track, { clientX: 100, pointerId: 1 });
    expect(scrollTo).toHaveBeenCalled();
    const call = scrollTo.mock.calls[0]![0] as { top: number };
    expect(call.top).toBeGreaterThanOrEqual(100);
    expect(call.top).toBeLessThanOrEqual(2100);
  });

  it('steps forward with the right arrow and smooth-scrolls', () => {
    render(
      <>
        <Grid />
        <Timeline files={filesAcross(['2024-01', '2025-06', '2026-09'])} label="Photos" />
      </>,
    );
    mockGridRect();
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo;

    const track = screen.getByRole('slider', { name: 'Photos timeline' });
    fireEvent.keyDown(track, { key: 'End' });
    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ top: expect.any(Number), behavior: 'smooth' }),
    );
  });

  it('labels the month under the pointer, placed against the same track', () => {
    render(
      <Timeline
        files={filesAcross(['2024-01', '2024-01', '2025-06', '2025-06', '2026-09'])}
        label="Photos"
      />,
    );
    const track = screen.getByRole('slider');
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 30,
      height: 30,
      left: 200,
      right: 1000,
      width: 800,
      x: 200,
      y: 0,
      toJSON: () => ({}),
    });

    // 90% along the track: the last file, from Sep 2026.
    fireEvent.pointerMove(track, { clientX: 920, pointerType: 'mouse' });
    const label = screen.getByTestId('timeline-label');
    expect(label).toHaveTextContent('Sep 2026');
    // The label and the flag share the track as their positioning box, so the
    // same percentage puts them under the pointer.
    expect(track).toContainElement(label);
    expect(label.style.left).toBe('90%');

    fireEvent.pointerMove(track, { clientX: 220, pointerType: 'mouse' });
    expect(screen.getByTestId('timeline-label')).toHaveTextContent('Jan 2024');
  });

  it('leaves out year numerals that would crowd each other', () => {
    // Ten years with one photo each, then a thousand from the eleventh: the
    // first ten land within a few pixels of each other on the ruler.
    const crowded = [
      ...Array.from({ length: 10 }, (_, i) => `${2010 + i}-06`),
      ...Array.from({ length: 990 }, () => '2020-06'),
      '2021-01',
    ];
    render(<Timeline files={filesAcross(crowded)} label="Photos" />);
    const shown = screen.queryAllByText(/^20\d\d$/).map((el) => el.textContent);
    expect(shown[0]).toBe('2010');
    expect(shown.length).toBeLessThan(5);
    // The year far enough away still gets its numeral.
    expect(shown).toContain('2021');
    // Every year still has a tick, numeral or not.
    expect(document.querySelectorAll('.timeline-tick.is-year')).toHaveLength(12);
  });
});
