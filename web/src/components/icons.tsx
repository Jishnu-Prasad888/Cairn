/**
 * Small outline icons drawn with the current text color, for cards and
 * headings. The navigation keeps its own set in AppShell.
 */

import type { ReactNode } from 'react';

function icon(children: ReactNode) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconPhoto = icon(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="m21 15-5-5L5 21" />
  </>,
);

export const IconVideo = icon(
  <>
    <rect x="2.5" y="5" width="13" height="14" rx="2" />
    <path d="m15.5 10.5 6-3.5v10l-6-3.5z" />
  </>,
);

export const IconFile = icon(
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </>,
);

export const IconMemory = icon(
  <>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
    <path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" />
  </>,
);

export const IconPeople = icon(
  <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-3.9 3.4-6 8-6s8 2.1 8 6" />
  </>,
);

export const IconAlbum = icon(
  <>
    <rect x="3.5" y="3.5" width="12" height="12" rx="2" />
    <circle cx="8" cy="8" r="1.4" />
    <path d="M10 20.5h8a2 2 0 0 0 2-2V11" />
  </>,
);

export const IconTag = icon(
  <>
    <path d="M3 3v6.5L12.8 19.3a1.9 1.9 0 0 0 2.7 0l3.8-3.8a1.9 1.9 0 0 0 0-2.7L8.5 3H3z" />
    <circle cx="7.2" cy="7.2" r="1.3" />
  </>,
);

export const IconStar = icon(
  <path d="m12 4 2.5 5.1 5.6.8-4 3.9 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4-3.9 5.6-.8z" />,
);
