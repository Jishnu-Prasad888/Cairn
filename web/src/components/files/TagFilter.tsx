/**
 * Picking tags to filter by, sized for a few dozen tags.
 *
 * Closed, it is one button ("Tags · 2") with the chosen tags as small chips
 * beside it. Open, it is a popover with a search box, the "match all" switch,
 * and a scrolling checklist, so a long vocabulary never spreads across the
 * filter bar.
 */

import { useEffect, useId, useRef, useState } from 'react';

import { tagKey } from '../../api/tagVocabulary';
import { Icon } from '../ui/Icon';

/** Chosen tags shown beside the button; the rest collapse into "+N more". */
const MAX_CHIPS = 3;

export function TagFilter({
  options,
  selected,
  matchAll,
  onChange,
  onMatchAllChange,
}: {
  options: string[];
  selected: string[];
  matchAll: boolean;
  onChange: (tags: string[]) => void;
  onMatchAllChange: (all: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popoverId = useId();

  // Close on a click outside or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const chosen = new Set(selected.map(tagKey));
  const toggle = (name: string) =>
    onChange(
      chosen.has(tagKey(name))
        ? selected.filter((t) => tagKey(t) !== tagKey(name))
        : [...selected, name],
    );
  const query = tagKey(search);
  const shown = query ? options.filter((o) => tagKey(o).includes(query)) : options;

  return (
    <div className="tag-filter" ref={rootRef}>
      <span className="field-label">Tags</span>
      <div className="tag-filter-row">
        <button
          type="button"
          className={
            selected.length ? 'button tag-filter-button active' : 'button tag-filter-button'
          }
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={popoverId}
          data-testid="tag-filter-button"
        >
          <Icon name="tag" size={16} />
          {selected.length ? `${selected.length} selected` : 'Any'}
          {selected.length > 1 && matchAll && (
            <span className="tag-filter-all-mark" title="Matching all selected tags">
              <Icon name="match-all" size={14} />
            </span>
          )}
          <Icon name="chevron-down" size={14} />
        </button>
        {selected.length > 0 && (
          <ul className="tag-filter-chosen" aria-label="Selected tags">
            {selected.slice(0, MAX_CHIPS).map((name) => (
              <li key={tagKey(name)} className="tag-chip">
                {name}
                <button type="button" aria-label={`Remove ${name}`} onClick={() => toggle(name)}>
                  <Icon name="close" size={12} />
                </button>
              </li>
            ))}
            {selected.length > MAX_CHIPS && (
              <li>
                <button
                  type="button"
                  className="tag-chip tag-chip-suggestion"
                  onClick={() => setOpen(true)}
                  title={selected.slice(MAX_CHIPS).join(', ')}
                >
                  +{selected.length - MAX_CHIPS} more
                </button>
              </li>
            )}
          </ul>
        )}
      </div>

      {open && (
        <div className="tag-filter-popover" id={popoverId} data-testid="tag-filter-popover">
          <input
            type="search"
            className="tag-filter-search"
            placeholder="Find a tag…"
            aria-label="Find a tag"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <label
            className={matchAll ? 'filter-match-all active' : 'filter-match-all'}
            title="Only show files that have every selected tag. Off: files with any of them."
          >
            <input
              type="checkbox"
              checked={matchAll}
              onChange={(e) => onMatchAllChange(e.target.checked)}
              data-testid="filter-tags-all"
            />
            <Icon name="match-all" size={16} />
            <span>Match all selected tags</span>
          </label>
          <ul className="tag-filter-list" role="group" aria-label="Tags">
            {shown.map((name) => (
              <li key={tagKey(name)}>
                <label className="tag-filter-option">
                  <input
                    type="checkbox"
                    checked={chosen.has(tagKey(name))}
                    onChange={() => toggle(name)}
                    data-testid={`filter-tag-${name}`}
                  />
                  <span>{name}</span>
                </label>
              </li>
            ))}
            {shown.length === 0 && <li className="muted tag-filter-empty">No matching tags.</li>}
          </ul>
          {selected.length > 0 && (
            <button type="button" className="button ghost-button" onClick={() => onChange([])}>
              Clear tags
            </button>
          )}
        </div>
      )}
    </div>
  );
}
