/**
 * Whether a person has chosen to show the timeline ruler. Off until asked
 * for, and remembered across Photos, Files, and every album once they turn
 * it on.
 */

const OPEN_KEY = 'cairn.timeline.open';

export function readTimelineOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function storeTimelineOpen(open: boolean): void {
  try {
    if (open) localStorage.setItem(OPEN_KEY, '1');
    else localStorage.removeItem(OPEN_KEY);
  } catch {
    // Not remembered; it just starts closed again next time.
  }
}

const SCALE_KEY = 'cairn.timeline.scale';
const SCALES = ['day', 'week', 'month', 'year'] as const;
type Scale = (typeof SCALES)[number];

/** The zoom last chosen with the timeline's magnifiers, if any. */
export function readTimelineScale(): Scale | null {
  try {
    const value = localStorage.getItem(SCALE_KEY);
    return SCALES.find((s) => s === value) ?? null;
  } catch {
    return null;
  }
}

export function storeTimelineScale(scale: Scale): void {
  try {
    localStorage.setItem(SCALE_KEY, scale);
  } catch {
    // Not remembered; the next visit starts at the page's own grouping.
  }
}
