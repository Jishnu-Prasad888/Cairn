/**
 * What a folder tile says about its size.
 *
 * A folder's count is the files the index holds under it. During a library's
 * first scan that is only what the scan has reached so far, so a folder of
 * thousands it has not got to yet would read "0 items". The server marks
 * such folders, and they say they are still being indexed instead.
 */

import type { FileSort, SortOrder } from '../../api/queries';
import type { Folder } from '../../api/types';

const numberFormat = new Intl.NumberFormat();

const items = (n: number) => `${numberFormat.format(n)} ${n === 1 ? 'item' : 'items'}`;

export function folderCountLabel(folder: Folder): string {
  const total = folder.index_total ?? 0;
  if (folder.index_state === 'scanning' && total > 0) {
    return `Indexing · ${numberFormat.format(folder.index_scanned ?? 0)} of ${numberFormat.format(total)}`;
  }
  if (folder.index_state === 'waiting') {
    return total > 0 ? `Waiting to index ${items(total)}` : 'Waiting to be indexed';
  }
  return items(folder.file_count);
}

/** True while the folder's count is still partial. */
export function folderIndexing(folder: Folder): boolean {
  return folder.index_state === 'waiting' || folder.index_state === 'scanning';
}

const byName = (a: Folder, b: Folder) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Folders in the order the page's sort asks for, the way a desktop file
 * manager orders them: by their newest file for a date sort, by the total size
 * under them for a size sort, and by name otherwise ("Type" has no meaning for
 * a folder, so it keeps them A–Z). Ties fall back to the name.
 */
export function sortFolders(
  folders: readonly Folder[],
  sort: FileSort,
  order: SortOrder,
): Folder[] {
  const dir = order === 'asc' ? 1 : -1;
  const list = [...folders];
  list.sort((a, b) => {
    let cmp = 0;
    if (sort === 'mod_time') {
      const av = a.mod_time ?? '';
      const bv = b.mod_time ?? '';
      if (av !== bv) {
        // Undated folders always go last, whichever way the dates run.
        if (!av) return 1;
        if (!bv) return -1;
        cmp = dir * (av < bv ? -1 : 1);
      }
    } else if (sort === 'size') {
      cmp = dir * ((a.size_bytes ?? 0) - (b.size_bytes ?? 0));
    } else if (sort === 'name') {
      cmp = dir * byName(a, b);
    }
    return cmp || byName(a, b);
  });
  return list;
}
