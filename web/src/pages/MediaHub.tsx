/**
 * Media — the unified browser for photos, videos, audio, documents, and other
 * files. A type-filter dropdown replaces the three separate nav entries so
 * there is one place to find any media.
 */

import MediaPage from './MediaPage';
import type { MediaPageConfig } from './MediaPage';

const CONFIG: MediaPageConfig = {
  title: 'Media',
  showFolders: true,
  showTypeFilter: true,
  subtitle: 'Your library — filter by type, browse folders, or search.',
  emptyTitle: 'Nothing here yet',
  emptyBody: 'Upload files or point Cairn at an existing folder of media.',
};

export default function MediaHub() {
  return <MediaPage config={CONFIG} />;
}
