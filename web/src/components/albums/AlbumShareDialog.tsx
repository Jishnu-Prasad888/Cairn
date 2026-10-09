/**
 * Sharing one album — a thin wrapper around the generic ShareDialog with the
 * album's own resource key and capability set. `read` alone only covers
 * listing and thumbnails — the viewer's full-size image and video playback
 * goes through the same download route a literal save does, so "view" has
 * to carry `download` too or opening a photo in the album just 403s
 * silently.
 */

import { albumKey } from '../../api/resourceKeys';
import type { Album } from '../../api/types';
import { ShareDialog } from '../sharing/ShareDialog';

export function AlbumShareDialog({
  libraryId,
  album,
  onClose,
}: {
  libraryId: string;
  album: Album;
  onClose: () => void;
}) {
  return (
    <ShareDialog
      libraryId={libraryId}
      resourceKey={albumKey(libraryId, album.id)}
      title={`Share "${album.name}"`}
      resourceLabel="album"
      testIdPrefix="album"
      viewCaps={['read', 'download']}
      editCaps={['read', 'download', 'edit']}
      onClose={onClose}
    />
  );
}
