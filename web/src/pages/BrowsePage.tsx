/**
 * Browse — the media browser with no type filter and no folder browsing.
 *
 * This is where the top-bar search lands: a flat, searchable view of the whole
 * library, whichever section a result turns out to belong to.
 */

import MediaPage from './MediaPage';
import type { MediaPageConfig } from './MediaPage';

const CONFIG: MediaPageConfig = {
  title: 'Browse',
  showFolders: false,
  subtitle: 'Everything in the library, filtered by the search above.',
  emptyTitle: 'Nothing matched',
  emptyBody: 'No file in this library matches that search. Try a shorter word or a different spelling.',
};

export default function BrowsePage() {
  return <MediaPage config={CONFIG} />;
}
