/**
 * Media type presentation and URL builders.
 *
 * One place decides what a media type is called and where its bytes and
 * thumbnails live, so the browser, the viewer, albums, tags, favorites, and
 * the share view all render the same glyph and hit the same endpoint.
 */

import { API_BASE } from '../api/client';
import type { FileSummary } from '../api/types';
import type { IconName } from './ui/Icon';

export const MEDIA_LABEL: Record<string, string> = {
  photo: 'Photo',
  video: 'Video',
  audio: 'Audio',
  document: 'Document',
  other: 'File',
};

/** The media types the API accepts as a `type` filter. */
export const MEDIA_TYPES = ['photo', 'video', 'audio', 'document', 'other'] as const;

export const mediaLabel = (mediaType?: string): string =>
  MEDIA_LABEL[mediaType ?? 'other'] ?? 'File';

/** The original bytes. Streams with Range support, so video seeks without a full download. */
export function downloadUrl(libraryId: string, file: Pick<FileSummary, 'id'>): string {
  return `${API_BASE}/libraries/${libraryId}/files/${file.id}/download`;
}

/**
 * The small JPEG preview the grid uses. Only photos have one.
 *
 * When the file's mod time and size are known they ride along as a version:
 * the server lets the browser keep a versioned thumbnail for good, so a grid
 * scrolled back into view or revisited is drawn from cache without a request,
 * and an edited file (new mod time or size) is a new URL.
 */
export function thumbnailUrl(
  libraryId: string,
  file: Pick<FileSummary, 'id'> & Partial<Pick<FileSummary, 'mod_time' | 'size_bytes'>>,
): string {
  return versioned(`${API_BASE}/libraries/${libraryId}/files/${file.id}/thumbnail`, file);
}

/**
 * The screen-sized JPEG the viewer shows in place of a photo's original: a
 * few hundred kilobytes where a camera original is tens of megabytes, with
 * the EXIF orientation already applied. Versioned like the thumbnail. A 404
 * means the original is small enough to show as it is.
 */
export function previewUrl(
  libraryId: string,
  file: Pick<FileSummary, 'id'> & Partial<Pick<FileSummary, 'mod_time' | 'size_bytes'>>,
): string {
  return versioned(`${API_BASE}/libraries/${libraryId}/files/${file.id}/preview`, file);
}

function versioned(
  base: string,
  file: Partial<Pick<FileSummary, 'mod_time' | 'size_bytes'>>,
): string {
  if (!file.mod_time || file.size_bytes === undefined) return base;
  return `${base}?v=${encodeURIComponent(`${file.mod_time}-${file.size_bytes}`)}`;
}

/** The file's extension, upper-cased, for a list view's Type column ("JPG"). */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : '';
}

/** Photo and video get a real preview; everything else falls back to a glyph. */
export function isPreviewable(file: FileSummary): boolean {
  return file.media_type === 'photo' || file.media_type === 'video';
}

/** The icon that stands for a file's media type, for tiles without a preview. */
export function mediaTypeIcon(mediaType: string | undefined): IconName {
  switch (mediaType) {
    case 'photo':
      return 'photo';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'document':
      return 'document';
    default:
      return 'file';
  }
}
