/**
 * Photos — the timeline: every photo in the library, newest first, grouped by
 * day. Folders do not matter here; that is what Files is for.
 */

import { useState } from 'react';

import { readPhotoLayout } from '../lib/photoLayout';
import MediaPage from './MediaPage';
import type { MediaPageConfig } from './MediaPage';

export default function PhotosPage() {
  const [layout] = useState(readPhotoLayout);
  const config: MediaPageConfig = {
    title: 'Photos',
    type: 'photo',
    grouping: 'day',
    masonry: layout === 'masonry',
    showTypeFilter: false,
    showTimeline: true,
    emptyTitle: 'No photos yet',
    emptyBody: "Once Cairn finds photos in your library, they'll appear here.",
    emptyIcon: 'photo',
  };
  return <MediaPage config={config} />;
}
