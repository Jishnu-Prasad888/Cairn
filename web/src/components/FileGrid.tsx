import type { ReactNode } from 'react';

import type { FileSummary } from '../api/types';
import { mediaGlyph, thumbnailUrl } from './media';
import './views.css';

interface FileGridProps {
  libraryId: string;
  files: FileSummary[];
  onOpen: (file: FileSummary) => void;
  /** Optional per-card overlay control, e.g. remove-from-album. */
  renderAction?: (file: FileSummary) => ReactNode;
  /** Ids currently selected (selection mode). Always passed together with
   * {@link onToggleSelect}; when omitted the grid is not selectable. */
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (file: FileSummary) => void;
}

/**
 * Google Photos–style media wall: a masonry of tiles that keep their natural
 * aspect ratio, showing a caption and a hover-visible selection circle.
 */
export function FileGrid({
  libraryId,
  files,
  onOpen,
  renderAction,
  selectedIds,
  onToggleSelect,
}: FileGridProps) {
  const selectable = selectedIds !== undefined && onToggleSelect !== undefined;
  const selecting = selectable && selectedIds.size > 0;

  return (
    <ul
      className={selecting ? 'file-grid selecting' : 'file-grid'}
      data-testid="file-grid"
    >
      {files.map((f) => {
        const selected = selectedIds?.has(f.id) ?? false;
        const media =
          f.media_type === 'photo' ? (
            <img
              className="file-card-thumb"
              src={thumbnailUrl(libraryId, f)}
              alt=""
              loading="lazy"
              decoding="async"
            />
          ) : (
            <span className="file-card-thumb file-card-glyph" aria-hidden="true">
              {mediaGlyph(f)}
            </span>
          );
        return (
          <li
            key={f.id}
            className={selected ? 'file-card selected' : 'file-card'}
          >
            <button type="button" className="file-card-main" onClick={() => onOpen(f)}>
              {media}
              <span className="file-card-caption" title={f.rel_path}>
                {f.name}
              </span>
            </button>
            {renderAction?.(f)}
            {selectable && (
              <button
                type="button"
                className={selected ? 'file-card-select active' : 'file-card-select'}
                aria-label={selected ? `Deselect ${f.name}` : `Select ${f.name}`}
                aria-pressed={selected}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSelect(f);
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}