/**
 * Whether the Photos grid lays tiles out as masonry's varied column
 * waterfall, or the uniform square grid every other media surface uses.
 * Masonry until someone opts out, and remembered from then on.
 */

export type PhotoLayout = 'masonry' | 'grid';

const STORAGE_KEY = 'cairn.photos.layout';

export function readPhotoLayout(): PhotoLayout {
  if (typeof localStorage === 'undefined') return 'masonry';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'grid') return 'grid';
  } catch {
    // Storage can be unavailable (private mode, disabled cookies) — fall back.
  }
  return 'masonry';
}

export function storePhotoLayout(layout: PhotoLayout): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (layout === 'grid') localStorage.setItem(STORAGE_KEY, 'grid');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // A failed write only means the choice is not remembered next visit.
  }
}
