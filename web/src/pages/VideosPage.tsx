/**
 * Videos — the media browser with a fixed `video` filter.
 */

import MediaPage from './MediaPage';
import type { MediaPageConfig } from './MediaPage';

const CONFIG: MediaPageConfig = {
  title: 'Videos',
  type: 'video',
  showFolders: true,
  subtitle: 'Every video in the library.',
  emptyTitle: 'No videos here',
  emptyBody: 'This folder has no videos. Upload some, or step into a subfolder.',
};

export default function VideosPage() {
  return <MediaPage config={CONFIG} />;
}
