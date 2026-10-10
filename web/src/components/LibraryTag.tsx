/**
 * The tiny "this belongs to library X" label on a card.
 *
 * It appears only on the corner of a card (or beside a name in a list), and
 * only when more than one library is open — with a single library open, every
 * card would say the same thing. The library name is resolved from the shared
 * list, so a card can be rendered with just the id it already carries.
 */

import { useLibraries } from '../api/libraries';

export function LibraryTag({
  libraryId,
  corner = false,
  className = '',
}: {
  libraryId?: string | null | undefined;
  /** Overlay the bottom-right corner of a card; otherwise sit inline. */
  corner?: boolean;
  className?: string;
}) {
  const { libraries, openLibraryIds } = useLibraries();
  if (!libraryId || openLibraryIds.length <= 1) return null;
  const name = libraries.find((lib) => lib.id === libraryId)?.name;
  if (!name) return null;
  return (
    <span
      className={
        corner
          ? `library-tag library-tag-corner ${className}`.trim()
          : `library-tag ${className}`.trim()
      }
      title={name}
      data-testid="library-tag"
      data-library-id={libraryId}
    >
      <span aria-hidden="true" className="library-tag-dot" />
      {name}
    </span>
  );
}