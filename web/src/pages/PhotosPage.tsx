/**
 * Photos — the media browser with a fixed `photo` filter.
 *
 * The browser is one component configured three ways; see MediaPage. Keeping
 * the configuration here means the route, the heading, and the wording stay
 * separate from the behaviour.
 */

import MediaPage from './MediaPage';
import type { MediaPageConfig } from './MediaPage';

const CONFIG: MediaPageConfig = {
  title: 'Photos',
  type: 'photo',
  showFolders: true,
  subtitle: 'Every photo in the library, in the order your files already live.',
  emptyTitle: 'No photos here',
  emptyBody: 'This folder has no photos. Upload some, or step into a subfolder.',
};

export default function PhotosPage() {
  return <MediaPage config={CONFIG} />;
}
