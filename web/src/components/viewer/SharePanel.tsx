import { fileKey } from '../../api/resourceKeys';
import type { FileSummary } from '../../api/types';
import { ShareDialogBody } from '../sharing/ShareDialog';

/**
 * Sharing one file — the viewer's Share tab, embedded directly in the
 * already-open viewer panel (not a dialog of its own; see ShareDialogBody).
 * `read` alone only covers listing and thumbnails — the public viewer's
 * full-size image and video playback goes through the same download route a
 * literal save does, so "view" has to carry `download` too or opening the
 * file just 403s silently (see AlbumShareDialog, which hit the same bug).
 */
export function SharePanel({ libraryId, file }: { libraryId: string; file: FileSummary }) {
  return (
    <div data-testid="viewer-share">
      <ShareDialogBody
        libraryId={libraryId}
        resourceKey={fileKey(libraryId, file.rel_path)}
        resourceLabel="file"
        testIdPrefix="file"
        viewCaps={['read', 'download']}
        editCaps={['read', 'download', 'edit']}
      />
    </div>
  );
}
