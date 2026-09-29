/**
 * Media type presentation and URL builders.
 *
 * One place decides what a media type is called and where its bytes and
 * thumbnails live, so the browser, the viewer, albums, tags, favorites, and
 * the share view all render the same glyph and hit the same endpoint.
 */

import { API_BASE } from '../api/client';
import type { FileSummary } from '../api/types';

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

export function downloadUrl(libraryId: string, file: FileSummary): string {
  return `${API_BASE}/libraries/${libraryId}/files/${file.id}/download`;
}

export function thumbnailUrl(libraryId: string, file: FileSummary): string {
  return `${API_BASE}/libraries/${libraryId}/files/${file.id}/thumbnail`;
}

export function mediaGlyph(file: FileSummary): string {
  if (file.media_type === 'photo') return '🖼';
  if (file.media_type === 'video') return '🎬';
  if (file.media_type === 'audio') return '🎵';
  if (file.media_type === 'document') return '📄';
  return '📦';
}

/** Photo and video get a real preview; everything else falls back to a glyph. */
export function isPreviewable(file: FileSummary): boolean {
  return file.media_type === 'photo' || file.media_type === 'video';
}
