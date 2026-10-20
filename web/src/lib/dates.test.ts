import { describe, expect, it } from 'vitest';

import { dayKey, formatDayHeading, greeting, monthKey, weekKey, yearKey } from './dates';

describe('dates', () => {
  it('keys a week by its Monday and a year by its number', () => {
    // Sunday Oct 4 2026 belongs to the week starting Monday Sep 28.
    expect(weekKey('2026-10-04T23:00:00')).toBe('2026-09-28');
    expect(weekKey('2026-09-28T00:30:00')).toBe('2026-09-28');
    // Across a year boundary: Fri Jan 1 2027 is in the week of Mon Dec 28.
    expect(weekKey('2027-01-01T12:00:00')).toBe('2026-12-28');
    expect(yearKey('2027-01-01T12:00:00')).toBe('2027');
    expect(weekKey('nonsense')).toBe('');
  });

  const now = new Date(2026, 8, 30, 10);

  it('keys a timestamp by local day and month', () => {
    expect(dayKey('2026-09-28T12:00:00')).toBe('2026-09-28');
    expect(monthKey('2026-09-28T12:00:00')).toBe('2026-09');
    expect(dayKey('not a date')).toBe('');
  });

  it('says Today and Yesterday for the last two days', () => {
    expect(formatDayHeading('2026-09-30', now)).toBe('Today');
    expect(formatDayHeading('2026-09-29', now)).toBe('Yesterday');
  });

  it('adds the year only for other years', () => {
    expect(formatDayHeading('2026-03-04', now)).not.toMatch(/2026/);
    expect(formatDayHeading('2025-03-04', now)).toMatch(/2025/);
  });

  it('labels an unparseable day as undated', () => {
    expect(formatDayHeading('', now)).toBe('Undated');
  });

  it('greets by the hour', () => {
    expect(greeting(new Date(2026, 0, 1, 9))).toBe('Good morning');
    expect(greeting(new Date(2026, 0, 1, 14))).toBe('Good afternoon');
    expect(greeting(new Date(2026, 0, 1, 20))).toBe('Good evening');
  });
});
