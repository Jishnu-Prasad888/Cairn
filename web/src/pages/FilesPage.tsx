/**
 * Files — the media browser with no type filter, so documents, archives, and
 * anything else the indexer could not classify appear alongside photos.
 */

import MediaPage from './MediaPage';
import type { MediaPageConfig } from './MediaPage';

const CONFIG: MediaPageConfig = {
  title: 'Files',
  subtitle: 'Everything the indexer found, whatever its type.',
  emptyTitle: 'Nothing here yet',
  emptyBody: 'This folder is empty. Upload a file to get started.',
};

export default function FilesPage() {
  return <MediaPage config={CONFIG} />;
}
