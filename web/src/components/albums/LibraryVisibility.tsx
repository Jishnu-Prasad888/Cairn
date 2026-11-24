/**
 * "Libraries" on the Albums page: a dropdown of checkboxes, one per library,
 * for choosing whose albums the grid shows. Unticking a library hides its
 * albums (a search still finds them, set apart and folded away).
 */

import { useEffect, useId, useRef, useState } from 'react';

import type { Library } from '../../api/types';
import { Icon } from '../ui/Icon';

export function LibraryVisibility({
  libraries,
  hidden,
  onChange,
}: {
  libraries: readonly Library[];
  hidden: readonly string[];
  onChange: (hidden: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const hiddenSet = new Set(hidden);
  const hiddenCount = libraries.filter((l) => hiddenSet.has(l.id)).length;

  // Click outside or Escape closes it, like any dropdown.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        wrap.current?.querySelector<HTMLButtonElement>('button')?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (id: string) => {
    const next = new Set(hiddenSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // Keep only ids of libraries that exist, in a stable order.
    onChange(libraries.filter((l) => next.has(l.id)).map((l) => l.id));
  };

  return (
    <div className="library-visibility" ref={wrap}>
      <button
        type="button"
        className={hiddenCount > 0 ? 'button active' : 'button'}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        aria-label={hiddenCount > 0 ? `Libraries: ${hiddenCount} hidden` : 'Libraries'}
        title="Choose which libraries' albums to show"
        data-testid="album-libraries-button"
      >
        <Icon name="eye-off" size={16} />
        {hiddenCount > 0 && <span className="library-visibility-count">{hiddenCount}</span>}
        {/* Phones keep the icon (and count); the words fold away. */}
        <span className="library-visibility-text">{hiddenCount > 0 ? 'hidden' : 'Libraries'}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open && (
        <div
          id={panelId}
          className="library-visibility-panel"
          role="group"
          aria-label="Show albums from"
          data-testid="album-libraries-panel"
        >
          <p className="library-visibility-title">Show albums from</p>
          {libraries.map((lib) => (
            <label key={lib.id} className="library-visibility-row">
              <input
                type="checkbox"
                checked={!hiddenSet.has(lib.id)}
                onChange={() => toggle(lib.id)}
              />
              <span>{lib.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
