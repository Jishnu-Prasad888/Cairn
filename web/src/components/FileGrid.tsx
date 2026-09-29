import { useState, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';

import type { FileSummary } from '../api/types';
import { mediaGlyph, thumbnailUrl } from './media';
import './views.css';

/** Single-file operations the grid card menu can trigger. */
export type GridFileAction = 'rename' | 'move' | 'copy' | 'trash' | 'remove';

interface FileGridProps {
  libraryId: string;
  files: FileSummary[];
  onOpen: (file: FileSummary) => void;
  /** Optional per-card overlay control, e.g. remove-from-album. */
  renderAction?: (file: FileSummary) => ReactNode;
  /** When provided, each card shows a ⋮ menu with file actions. */
  onAction?: (action: GridFileAction, file: FileSummary) => void;
  /** Labels for which actions to show; defaults to rename/move/copy/trash. */
  actions?: GridFileAction[];
  /** Ids currently selected (selection mode). Always passed together with
   * {@link onToggleSelect}; when omitted the grid is not selectable. */
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (file: FileSummary, shiftKey?: boolean) => void;
}

const DEFAULT_ACTIONS: GridFileAction[] = ['rename', 'move', 'copy', 'trash'];

const ACTION_LABEL: Record<GridFileAction, string> = {
  rename: 'Rename',
  move: 'Move',
  copy: 'Copy',
  trash: 'Move to trash',
  remove: 'Remove from album',
};

/** A floating ⋮ action menu for a single card. */
function CardMenu({
  file,
  actions,
  onAction,
  onClose,
}: {
  file: FileSummary;
  actions: GridFileAction[];
  onAction: (action: GridFileAction, file: FileSummary) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLUListElement | null>(null);

  // Close on click outside or Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <ul className="card-menu" role="menu" ref={menuRef}>
      {actions.map((action) => (
        <li key={action} role="none">
          <button
            type="button"
            role="menuitem"
            className={
              action === 'trash' || action === 'remove'
                ? 'card-menu-item card-menu-danger'
                : 'card-menu-item'
            }
            onClick={(e) => {
              e.stopPropagation();
              onAction(action, file);
              onClose();
            }}
          >
            {ACTION_LABEL[action]}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * A uniform tile wall: every tile is a square, so a portrait photo is
 * centre-cropped rather than making its row twice as tall as the one above it.
 * A caption and a selection circle fade in on hover, or stay visible for the
 * whole grid while a selection is in progress.
 */
export function FileGrid({
  libraryId,
  files,
  onOpen,
  renderAction,
  onAction,
  actions = DEFAULT_ACTIONS,
  selectedIds,
  onToggleSelect,
}: FileGridProps) {
  const selectable = selectedIds !== undefined && onToggleSelect !== undefined;
  const selecting = selectable && selectedIds.size > 0;
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  return (
    <ul className={selecting ? 'file-grid selecting' : 'file-grid'} data-testid="file-grid">
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
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(
                'application/cairn-file',
                JSON.stringify({ id: f.id, rel_path: f.rel_path, name: f.name }),
              );
              e.dataTransfer.effectAllowed = 'move';
            }}
          >
            <button type="button" className="file-card-main" onClick={() => onOpen(f)}>
              {media}
              <span className="file-card-caption" title={f.rel_path}>
                {f.name}
              </span>
            </button>
            {renderAction?.(f)}
            {onAction && (
              <div className="card-menu-wrap">
                <button
                  type="button"
                  className="card-menu-trigger"
                  aria-label={`Actions for ${f.name}`}
                  aria-haspopup="menu"
                  aria-expanded={openMenuId === f.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenMenuId((prev) => (prev === f.id ? null : f.id));
                  }}
                >
                  ⋮
                </button>
                {openMenuId === f.id && (
                  <CardMenu
                    file={f}
                    actions={actions}
                    onAction={onAction}
                    onClose={() => setOpenMenuId(null)}
                  />
                )}
              </div>
            )}
            {selectable && (
              <button
                type="button"
                className={selected ? 'file-card-select active' : 'file-card-select'}
                aria-label={selected ? `Deselect ${f.name}` : `Select ${f.name}`}
                aria-pressed={selected}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSelect(f, e.shiftKey);
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
