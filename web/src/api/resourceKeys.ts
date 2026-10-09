/**
 * Resource keys — the single canonical form every sharing/permission surface
 * must send the server. Mirrors internal/authz/authz.go's
 * FolderKey/FileKey/EntityKey exactly: a folder marks every path segment
 * with `f:`, a file marks only its terminal segment with `x:`, and an
 * album/memory hangs off the library with its own single-letter marker.
 *
 * The server only recognizes a key that already starts with the raw library
 * id (see internal/httpapi/permissions.go's normalizeLibraryKey) — anything
 * else, including a human-friendly `file:<lib>/<path>` label, falls through
 * to being treated as a literal (and wrong) folder path. These helpers are
 * the only place that convention should be built.
 */

export function libraryKey(libraryId: string): string {
  return libraryId;
}

export function folderKey(libraryId: string, relPath: string): string {
  const trimmed = relPath.replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return libraryKey(libraryId);
  return (
    libraryId +
    '/' +
    trimmed
      .split('/')
      .map((seg) => `f:${seg}`)
      .join('/')
  );
}

export function fileKey(libraryId: string, relPath: string): string {
  const trimmed = relPath.replace(/^\/+/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx < 0) return `${libraryId}/x:${trimmed}`;
  return folderKey(libraryId, trimmed.slice(0, idx)) + `/x:${trimmed.slice(idx + 1)}`;
}

export function albumKey(libraryId: string, albumId: string): string {
  return `${libraryId}/a:${albumId}`;
}

export function memoryKey(libraryId: string, memoryId: string): string {
  return `${libraryId}/m:${memoryId}`;
}

/**
 * Parses the admin Sharing page's free-text "what the link exposes" field,
 * which accepts the human-friendly `library:`/`folder:`/`file:` labels (with
 * or without the redundant `<library-id>/` prefix on the path, since typing
 * the id twice is easy to get wrong) and turns them into the canonical key
 * the server actually understands. Anything else — already canonical, or a
 * scope these helpers don't cover (e.g. a tag) — passes through unchanged,
 * so a key pasted from elsewhere still works.
 */
export function parseAdminResourceKey(libraryId: string, raw: string): string {
  const trimmed = raw.trim();
  const libPrefix = `${libraryId}/`;
  const stripLibPrefix = (s: string) => (s.startsWith(libPrefix) ? s.slice(libPrefix.length) : s);

  if (trimmed === 'library:' || trimmed === `library:${libraryId}`) return libraryKey(libraryId);
  if (trimmed.startsWith('folder:')) return folderKey(libraryId, stripLibPrefix(trimmed.slice(7)));
  if (trimmed.startsWith('file:')) return fileKey(libraryId, stripLibPrefix(trimmed.slice(5)));
  return trimmed;
}
