/**
 * The small-thumbnail loading pulse (see `img.thumb-loading` in base.css).
 *
 * Give an `<img>` the `thumb-loading` class and this as its `onLoad`: its
 * background pulses until the image arrives, then stops. The flag is set on
 * the element directly, so a list of hundreds of thumbnails finishing never
 * re-renders anything.
 */

import type { SyntheticEvent } from 'react';

export function markThumbLoaded(event: SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.dataset.loaded = 'true';
}
