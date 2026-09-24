import { API_BASE } from '../api/client';
import type { FileSummary } from '../api/types';

export const MEDIA_LABEL: Record<string, string> = {
  photo: 'Photo',
  video: 'Video',
  audio: 'Audio',
  document: 'Document',
  other: 'File',
};

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
