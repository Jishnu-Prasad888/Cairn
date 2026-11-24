/**
 * Dragging things around inside Cairn: files, a whole selection of them, and
 * folders. A drag carries what was picked up under a Cairn-only type, so a
 * drop target can tell an in-app move from files dragged in from the desktop
 * (an upload), and so other sites never see a Cairn drag as anything at all.
 */

import type { FileSummary, Folder } from '../../api/types';

export const FILE_DRAG = 'application/cairn-file';
export const FOLDER_DRAG = 'application/cairn-folder';

export interface DraggedFile {
  id: string;
  rel_path: string;
  name: string;
}

export interface DraggedFolder {
  rel_path: string;
  name: string;
  library_id?: string | undefined;
}

/** True for a drag of Cairn files or folders (not a desktop upload). */
export function isCairnDrag(event: React.DragEvent): boolean {
  const types = event.dataTransfer.types;
  return types.includes(FILE_DRAG) || types.includes(FOLDER_DRAG);
}

/** True for files dragged in from outside the browser. */
export function isDesktopDrag(event: React.DragEvent): boolean {
  return event.dataTransfer.types.includes('Files') && !isCairnDrag(event);
}

/**
 * A small "3 items" chip under the pointer instead of the browser's ghost of
 * one tile, when more than one thing is moving. Removed once the browser has
 * taken its snapshot.
 */
function setCountImage(event: React.DragEvent, count: number) {
  if (count <= 1 || typeof document === 'undefined') return;
  const chip = document.createElement('div');
  chip.className = 'drag-count-chip';
  chip.textContent = `${count} items`;
  document.body.appendChild(chip);
  try {
    event.dataTransfer.setDragImage(chip, 16, 16);
  } catch {
    // Not supported: the default ghost is fine.
  }
  window.setTimeout(() => chip.remove(), 0);
}

/**
 * Start dragging a file. `count` is how many files move with it: the whole
 * selection when the file is part of one (the drop target then moves them
 * all), otherwise just this one.
 */
export function startFileDrag(event: React.DragEvent, file: FileSummary, count = 1) {
  const payload: DraggedFile = { id: file.id, rel_path: file.rel_path, name: file.name };
  event.dataTransfer.setData(FILE_DRAG, JSON.stringify(payload));
  event.dataTransfer.effectAllowed = 'copyMove';
  setCountImage(event, count);
}

export function startFolderDrag(event: React.DragEvent, folder: Folder) {
  const payload: DraggedFolder = {
    rel_path: folder.rel_path,
    name: folder.name,
    library_id: folder.library_id,
  };
  event.dataTransfer.setData(FOLDER_DRAG, JSON.stringify(payload));
  event.dataTransfer.effectAllowed = 'move';
}

/** What a drop carries, if it is a Cairn drag. */
export function readDrag(
  event: React.DragEvent,
): { file?: DraggedFile; folder?: DraggedFolder } | null {
  try {
    const file = event.dataTransfer.getData(FILE_DRAG);
    if (file) return { file: JSON.parse(file) as DraggedFile };
    const folder = event.dataTransfer.getData(FOLDER_DRAG);
    if (folder) return { folder: JSON.parse(folder) as DraggedFolder };
  } catch {
    // Not ours, or mangled: nothing to drop.
  }
  return null;
}
