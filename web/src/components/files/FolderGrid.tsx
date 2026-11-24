/**
 * The sub-folders of the current folder, as compact tiles above its files.
 *
 * A tile behaves like a folder in a desktop file manager:
 * - click opens it; right-click (or the ⋯ button) opens its menu;
 * - it can be dragged onto another folder or a breadcrumb to move it;
 * - files or folders dragged inside Cairn can be dropped on it to move them
 *   in, and files dragged in from the desktop drop on it to upload into it;
 * - a favourite folder carries a small star.
 */

import { useState } from 'react';

import type { Folder } from '../../api/types';
import { LibraryTag } from '../LibraryTag';
import { Icon } from '../ui/Icon';
import { startFolderDrag } from './dragPayload';
import { folderDropProps, type FolderTileHandlers } from './folderDrop';
import { folderCountLabel, folderIndexing } from './folderCount';
import './Files.css';

export function FolderGrid({
  folders,
  onOpen,
  onDropFile,
  onUploadInto,
  onMenu,
  draggable = false,
  isFavorite,
}: { folders: Folder[] } & FolderTileHandlers) {
  const [over, setOver] = useState<string | null>(null);
  if (folders.length === 0) return null;

  return (
    <ul className="folder-grid" aria-label="Folders" data-testid="folder-grid">
      {folders.map((folder) => {
        const favorite = isFavorite?.(folder) ?? false;
        return (
          <li key={`${folder.library_id ?? ''}:${folder.id}`} className="folder-tile-wrap">
            <button
              type="button"
              className={over === folder.rel_path ? 'folder-tile is-drop-target' : 'folder-tile'}
              onClick={() => onOpen(folder)}
              onContextMenu={(event) => {
                if (!onMenu) return;
                event.preventDefault();
                onMenu(folder, event.clientX, event.clientY);
              }}
              draggable={draggable}
              onDragStart={(event) => startFolderDrag(event, folder)}
              {...folderDropProps(folder, { onDropFile, onUploadInto }, setOver)}
              data-testid={`folder-${folder.id}`}
            >
              <Icon name="folder" size={22} className="folder-tile-icon" />
              <span className="folder-tile-text">
                <span className="folder-tile-name">
                  {folder.name}
                  {favorite && (
                    <span className="folder-tile-fav" title="Favourite">
                      <Icon name="star" size={13} filled />
                      <span className="visually-hidden">(favourite)</span>
                    </span>
                  )}
                </span>
                <span
                  className={
                    folderIndexing(folder) ? 'folder-tile-count is-indexing' : 'folder-tile-count'
                  }
                >
                  {folderCountLabel(folder)}
                </span>
              </span>
            </button>
            {onMenu && (
              <button
                type="button"
                className="icon-button folder-tile-share"
                aria-label={`More actions for ${folder.name}`}
                aria-haspopup="menu"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  onMenu(folder, rect.right - 200, rect.bottom + 4);
                }}
                data-testid={`folder-menu-${folder.id}`}
              >
                <Icon name="more" size={16} />
              </button>
            )}
            <LibraryTag libraryId={folder.library_id} corner />
          </li>
        );
      })}
    </ul>
  );
}
