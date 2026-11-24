/**
 * Dropping files — and folders — from the desktop onto a page to upload them.
 *
 * Only real files count — dragging a tile inside Cairn (to move it into a
 * folder) is a different gesture and must not light up the upload target.
 * Enter/leave events fire for every child crossed, so a depth counter decides
 * when the drag has really left.
 *
 * A dropped folder is not a file. `dataTransfer.files` still lists it, as a
 * zero-byte placeholder that cannot be read: uploading that placeholder is
 * what failed with "The connection to the server was lost". The folder is
 * walked through the entries API instead, and every file inside it is
 * uploaded under its path, so the folder arrives with its structure.
 */

import { useCallback, useRef, useState } from 'react';

import type { UploadEntry } from './uploadEntries';
import { entriesFromFiles, entriesFromDrop } from './uploadEntries';

const hasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes('Files');

export function useFileDrop(onFiles: (entries: UploadEntry[]) => void, enabled = true) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const onDragEnter = useCallback(
    (event: React.DragEvent) => {
      if (!enabled || !hasFiles(event)) return;
      event.preventDefault();
      // The innermost drop zone owns the drag: the app shell's own (which
      // uploads to the library root) stays dark under a page that has one.
      event.stopPropagation();
      depth.current += 1;
      setDragging(true);
    },
    [enabled],
  );

  const onDragOver = useCallback(
    (event: React.DragEvent) => {
      if (!enabled || !hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
    },
    [enabled],
  );

  const onDragLeave = useCallback(
    (event: React.DragEvent) => {
      if (!enabled || !hasFiles(event)) return;
      event.stopPropagation();
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    [enabled],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      if (!enabled || !hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      depth.current = 0;
      setDragging(false);
      // The item list is only readable during the event, so the entries are
      // taken now and walked afterwards.
      const fromItems = entriesFromDrop(event.dataTransfer);
      const plainFiles = Array.from(event.dataTransfer.files ?? []);
      void fromItems.then((entries) => {
        const list = entries ?? entriesFromFiles(plainFiles);
        if (list.length) onFiles(list);
      });
    },
    [enabled, onFiles],
  );

  return { dragging, bind: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
