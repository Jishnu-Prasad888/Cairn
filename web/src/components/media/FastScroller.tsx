/**
 * The phone's fast-scroll handle: a thumb on the right edge that appears while
 * the page scrolls and can be dragged to fly through a long grid, with a
 * bubble naming the month under it — the way a camera roll is skimmed. It
 * stands in for the desktop's timeline ruler, which has no room on a phone.
 *
 * It drives the window scroll directly and reads which file is on screen from
 * the grid's tiles (`[data-index]`), so it needs nothing from the grid but
 * the files it was given.
 */

import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import type { FileSummary } from '../../api/types';
import { monthKey } from '../../lib/dates';
import './FastScroller.css';

/** How long the thumb stays after the page stops moving. */
const LINGER_MS = 1400;
/** Below this many screens of content there is nothing to skim. */
const MIN_SCREENS = 3;
/** Space kept clear above and below the track (top bar, bottom navigation). */
const TRACK_TOP = 72;
const TRACK_BOTTOM = 88;
const THUMB_HEIGHT = 48;

function monthLabel(file: FileSummary | undefined): string {
  const key = file ? monthKey(file.mod_time) : '';
  if (!key) return '';
  const [y, m] = key.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, 1).toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
  });
}

/** The thumb's travel, and how far the page can scroll. */
function track() {
  const height = window.innerHeight - TRACK_TOP - TRACK_BOTTOM - THUMB_HEIGHT;
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return { height: Math.max(1, height), max };
}

export function FastScroller({ files }: { files: readonly FileSummary[] }) {
  const [state, setState] = useState({ visible: false, top: 0, label: '' });
  const [dragging, setDragging] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  });

  /** The month of the topmost tile on screen. */
  const currentLabel = useCallback(() => {
    for (const y of [TRACK_TOP + 40, TRACK_TOP + 120, window.innerHeight / 2]) {
      const el = document.elementFromPoint(8, y)?.closest<HTMLElement>('[data-index]');
      const index = el ? Number(el.dataset.index) : NaN;
      if (Number.isInteger(index)) return monthLabel(filesRef.current[index]);
    }
    return '';
  }, []);

  const sync = useCallback(
    (show: boolean) => {
      const { height, max } = track();
      if (max < window.innerHeight * (MIN_SCREENS - 1)) {
        setState((s) => (s.visible ? { ...s, visible: false } : s));
        return;
      }
      const top = TRACK_TOP + (Math.min(window.scrollY, max) / max) * height;
      setState((s) => ({ visible: show || s.visible, top, label: currentLabel() }));
    },
    [currentLabel],
  );

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setState((s) => ({ ...s, visible: false })), LINGER_MS);
  }, []);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        sync(true);
        scheduleHide();
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [sync, scheduleHide]);

  const scrollToPointer = (clientY: number) => {
    const { height, max } = track();
    const fraction = Math.min(1, Math.max(0, (clientY - TRACK_TOP - THUMB_HEIGHT / 2) / height));
    window.scrollTo({ top: fraction * max });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setDragging(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging) scrollToPointer(event.clientY);
  };
  const onPointerUp = () => {
    setDragging(false);
    scheduleHide();
  };

  const shown = state.visible || dragging;
  return (
    <div
      className={['fast-scroller', shown ? 'is-visible' : '', dragging ? 'is-dragging' : '']
        .filter(Boolean)
        .join(' ')}
      style={{ transform: `translateY(${state.top}px)` }}
      aria-hidden="true"
      data-testid="fast-scroller"
    >
      {dragging && state.label && <span className="fast-scroller-label">{state.label}</span>}
      <div
        className="fast-scroller-thumb"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <svg width="14" height="20" viewBox="0 0 14 20" aria-hidden="true">
          <path d="M3 8l4-4 4 4M3 12l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      </div>
    </div>
  );
}
