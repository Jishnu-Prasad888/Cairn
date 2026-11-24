/**
 * A folder as a drop target, shared by the grid's tiles and the list's rows:
 * Cairn files and folders dropped on it move in, desktop files upload into it.
 */

import type { Folder } from '../../api/types';
import { entriesFromDrop, entriesFromFiles, type UploadEntry } from '../upload/uploadEntries';
import { isCairnDrag, isDesktopDrag } from './dragPayload';

export interface FolderTileHandlers {
  onOpen: (folder: Folder) => void;
  /** A Cairn file or folder was dropped onto `folderPath`. */
  onDropFile?: ((event: React.DragEvent, folderPath: string) => void) | undefined;
  /** Desktop files were dropped onto a folder: upload them into it. */
  onUploadInto?: ((folder: Folder, entries: UploadEntry[]) => void) | undefined;
  /** Open the folder's menu at a point on screen. */
  onMenu?: ((folder: Folder, x: number, y: number) => void) | undefined;
  /** Whether folders can be dragged to move them. */
  draggable?: boolean | undefined;
  /** Whether a folder is starred as a favourite. */
  isFavorite?: ((folder: Folder) => boolean) | undefined;
}

/** How a favourite folder is keyed across libraries. */
export const folderFavKey = (libraryId: string | undefined, relPath: string) =>
  `${libraryId ?? ''}:${relPath}`;

/**
 * The drag-over / drop half of a folder target, shared by tiles and list rows.
 * `over` is the highlighted target; `setOver` changes it.
 */
export function folderDropProps(
  folder: Folder,
  { onDropFile, onUploadInto }: Pick<FolderTileHandlers, 'onDropFile' | 'onUploadInto'>,
  setOver: (path: string | null) => void,
) {
  const accepts = (event: React.DragEvent) =>
    (onDropFile && isCairnDrag(event)) || (onUploadInto && isDesktopDrag(event));
  return {
    onDragOver: (event: React.DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      // Keep the page's own "drop to upload here" out of it: this is the target.
      event.stopPropagation();
      event.dataTransfer.dropEffect = isDesktopDrag(event) ? 'copy' : 'move';
      setOver(folder.rel_path);
    },
    onDragEnter: (event: React.DragEvent) => {
      if (accepts(event)) event.stopPropagation();
    },
    onDragLeave: () => setOver(null),
    onDrop: (event: React.DragEvent) => {
      setOver(null);
      if (onUploadInto && isDesktopDrag(event)) {
        event.preventDefault();
        event.stopPropagation();
        const plain = Array.from(event.dataTransfer.files ?? []);
        void entriesFromDrop(event.dataTransfer).then((entries) => {
          const list = entries ?? entriesFromFiles(plain);
          if (list.length) onUploadInto(folder, list);
        });
        return;
      }
      if (onDropFile && isCairnDrag(event)) {
        event.stopPropagation();
        onDropFile(event, folder.rel_path);
      }
    },
  };
}
